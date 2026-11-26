import {
  AgentAbortedError,
  CixCodeError,
  isAbortError,
} from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import { noopLogger } from "../core/logger.js";
import {
  emptyUsage,
  type AgentEvent,
  type AgentResult,
  type FinishReason,
  type LLMEvent,
  type Message,
  type RunInput,
  type Usage,
} from "../core/types.js";
import type { LLMProvider } from "../llm/provider.js";
import { ToolRunner } from "./tool-runner.js";

export interface AgentOptions {
  maxSteps?: number;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  logger?: Logger;
}

interface ToolCallState {
  id: string;
  name: string;
  arguments: string;
}

export class Agent {
  private readonly maxSteps: number;
  private readonly logger: Logger;

  constructor(
    private readonly provider: LLMProvider,
    private readonly toolRunner: ToolRunner,
    private readonly options: AgentOptions = {},
  ) {
    this.maxSteps = options.maxSteps ?? 10;
    this.logger = options.logger ?? noopLogger;
    if (!Number.isInteger(this.maxSteps) || this.maxSteps < 1) {
      throw new CixCodeError(
        "AGENT_CONFIG_INVALID",
        "maxSteps must be a positive integer",
      );
    }
  }

  async *run(input: RunInput): AsyncIterable<AgentEvent> {
    const signal = input.signal ?? new AbortController().signal;
    const messages = cloneMessages(input.messages);
    const usage = emptyUsage();

    if (this.options.systemPrompt && messages[0]?.role !== "system") {
      messages.unshift({
        role: "system",
        content: this.options.systemPrompt,
      });
    }

    let lastFinishReason: FinishReason | undefined;

    for (let step = 1; step <= this.maxSteps; step++) {
      if (signal.aborted) throw new AgentAbortedError(signal.reason);
      yield { type: "step-start", step };

      const assistant: Message = {
        role: "assistant",
        content: "",
        toolCalls: [],
      };
      const toolStates = new Map<number, ToolCallState>();
      let finishReason: FinishReason | undefined;

      try {
        for await (const event of this.provider.stream(
          {
            messages: messages.map(cloneMessage),
            tools: this.toolRunner.definitions,
            temperature: this.options.temperature,
            maxTokens: this.options.maxTokens,
          },
          signal,
        )) {
          applyLLMEvent(
            event,
            assistant,
            toolStates,
            usage,
            (reason) => {
              finishReason = reason;
            },
          );

          if (event.type === "text-delta") {
            yield { type: "text-delta", delta: event.delta };
          }
        }
      } catch (error) {
        if (isAbortError(error)) throw new AgentAbortedError(error);
        if (error instanceof CixCodeError) throw error;
        throw new CixCodeError(
          "PROVIDER_STREAM_FAILED",
          error instanceof Error ? error.message : "Provider stream failed",
          { cause: error },
        );
      }

      if (!finishReason) {
        throw new CixCodeError(
          "PROVIDER_RESPONSE_INVALID",
          "Provider stream ended without a finish reason",
        );
      }

      lastFinishReason = finishReason;
      const toolCalls = [...toolStates.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, state]) => ({ ...state }));

      if (toolCalls.some((call) => !call.id || !call.name)) {
        throw new CixCodeError(
          "PROVIDER_RESPONSE_INVALID",
          "Provider returned an incomplete tool call",
        );
      }
      if (finishReason === "length" && toolCalls.length > 0) {
        throw new CixCodeError(
          "PROVIDER_RESPONSE_INVALID",
          "Provider returned truncated tool calls",
        );
      }

      assistant.toolCalls = toolCalls;
      messages.push(assistant);

      if (toolCalls.length === 0) {
        yield {
          type: "done",
          result: {
            status: "completed",
            messages,
            usage,
            finishReason,
          },
        };
        return;
      }

      for (const call of toolCalls) {
        if (signal.aborted) throw new AgentAbortedError(signal.reason);
        yield { type: "tool-start", call };
        const execution = await this.toolRunner.execute(call, signal);
        messages.push(execution.message);
        yield { type: "tool-end", call, result: execution.result };
      }
    }

    const result: AgentResult = {
      status: "max_steps",
      messages,
      usage,
      finishReason: lastFinishReason,
    };
    yield { type: "done", result };
  }
}

function cloneMessages(messages: Message[]): Message[] {
  return messages.map(cloneMessage);
}

function cloneMessage(message: Message): Message {
  const clone: Message = { ...message };
  if (message.toolCalls) {
    clone.toolCalls = message.toolCalls.map((call) => ({ ...call }));
  }
  return clone;
}

function applyLLMEvent(
  event: LLMEvent,
  assistant: Message,
  toolStates: Map<number, ToolCallState>,
  usage: Usage,
  setFinishReason: (reason: FinishReason) => void,
): void {
  switch (event.type) {
    case "text-delta":
      assistant.content = `${assistant.content ?? ""}${event.delta}`;
      return;
    case "tool-call-start": {
      const existing = toolStates.get(event.index);
      if (existing) {
        throw new CixCodeError(
          "PROVIDER_RESPONSE_INVALID",
          `Duplicate tool call start for index ${event.index}`,
        );
      }
      toolStates.set(event.index, {
        id: event.id,
        name: event.name,
        arguments: "",
      });
      return;
    }
    case "tool-call-delta": {
      const state = toolStates.get(event.index);
      if (!state) {
        throw new CixCodeError(
          "PROVIDER_RESPONSE_INVALID",
          `Tool call delta without start for index ${event.index}`,
        );
      }
      state.arguments += event.argumentsDelta;
      return;
    }
    case "tool-call-end":
      if (!toolStates.has(event.index)) {
        throw new CixCodeError(
          "PROVIDER_RESPONSE_INVALID",
          `Tool call end without start for index ${event.index}`,
        );
      }
      return;
    case "usage":
      usage.inputTokens += event.usage.inputTokens;
      usage.outputTokens += event.usage.outputTokens;
      usage.totalTokens += event.usage.totalTokens;
      return;
    case "finish":
      setFinishReason(event.reason);
      return;
  }
}
