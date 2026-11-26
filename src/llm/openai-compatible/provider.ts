import {
  AgentAbortedError,
  CixCodeError,
  isAbortError,
} from "../../core/errors.js";
import type {
  FinishReason,
  LLMEvent,
  LLMRequest,
  Message,
  ToolCall,
  Usage,
} from "../../core/types.js";
import type { LLMProvider } from "../provider.js";
import { readSSE } from "./sse.js";

export interface OpenAICompatibleProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  defaultHeaders?: Record<string, string>;
  maxRetries?: number;
}

interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: OpenAIToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

interface ToolCallState {
  id?: string;
  name?: string;
  arguments: string;
  started: boolean;
  pendingArguments: string[];
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly model: string;
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly maxRetries: number;

  constructor(
    options: OpenAICompatibleProviderOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!options.baseUrl || !options.apiKey || !options.model) {
      throw new CixCodeError(
        "PLUGIN_CONFIG_INVALID",
        "baseUrl, apiKey and model are required",
      );
    }

    let baseUrl: URL;
    try {
      baseUrl = new URL(options.baseUrl);
    } catch (error) {
      throw new CixCodeError("PLUGIN_CONFIG_INVALID", "Invalid baseUrl", {
        cause: error,
      });
    }
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      throw new CixCodeError(
        "PLUGIN_CONFIG_INVALID",
        "baseUrl must use http or https",
      );
    }

    const normalized = options.baseUrl.replace(/\/$/, "");
    this.endpoint = normalized.endsWith("/chat/completions")
      ? normalized
      : `${normalized}/chat/completions`;
    this.model = options.model;
    this.maxRetries = options.maxRetries ?? 2;
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0) {
      throw new CixCodeError(
        "PLUGIN_CONFIG_INVALID",
        "maxRetries must be a non-negative integer",
      );
    }
    this.headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
      ...options.defaultHeaders,
    };
  }

  async *stream(
    request: LLMRequest,
    signal: AbortSignal,
  ): AsyncIterable<LLMEvent> {
    const response = await this.request(request, signal);
    if (!response.body) {
      throw new CixCodeError(
        "PROVIDER_RESPONSE_INVALID",
        "Provider response has no body",
      );
    }

    const toolStates = new Map<number, ToolCallState>();
    let sawFinish = false;
    let endedTools = false;

    for await (const data of readSSE(response.body, signal)) {
      if (data === "[DONE]") break;

      let chunk: OpenAIChunk;
      try {
        chunk = JSON.parse(data) as OpenAIChunk;
      } catch (error) {
        throw new CixCodeError(
          "PROVIDER_RESPONSE_INVALID",
          "Invalid JSON in provider stream",
          { cause: error },
        );
      }

      if (chunk.error) {
        throw new CixCodeError(
          "PROVIDER_REQUEST_FAILED",
          chunk.error.message ?? "Provider returned an error",
        );
      }

      const choice = chunk.choices?.[0];
      const content = choice?.delta?.content;
      if (content) yield { type: "text-delta", delta: content };

      for (const delta of choice?.delta?.tool_calls ?? []) {
        let state = toolStates.get(delta.index);
        if (!state) {
          state = {
            arguments: "",
            started: false,
            pendingArguments: [],
          };
          toolStates.set(delta.index, state);
        }
        if (delta.id) state.id = delta.id;
        if (delta.function?.name) state.name = delta.function.name;
        if (delta.function?.arguments) {
          state.arguments += delta.function.arguments;
          if (state.started) {
            yield {
              type: "tool-call-delta",
              index: delta.index,
              argumentsDelta: delta.function.arguments,
            };
          } else {
            state.pendingArguments.push(delta.function.arguments);
          }
        }

        if (!state.started && state.id && state.name) {
          state.started = true;
          yield {
            type: "tool-call-start",
            index: delta.index,
            id: state.id,
            name: state.name,
          };
          for (const argumentsDelta of state.pendingArguments) {
            yield {
              type: "tool-call-delta",
              index: delta.index,
              argumentsDelta,
            };
          }
          state.pendingArguments = [];
        }
      }

      if (chunk.usage) {
        yield { type: "usage", usage: toUsage(chunk.usage) };
      }

      if (choice?.finish_reason) {
        sawFinish = true;
        if (!endedTools) {
          for (const index of [...toolStates.keys()].sort((a, b) => a - b)) {
            const state = toolStates.get(index)!;
            if (!state.started) {
              if (!state.id || !state.name) {
                throw new CixCodeError(
                  "PROVIDER_RESPONSE_INVALID",
                  `Incomplete tool call at index ${index}`,
                );
              }
              state.started = true;
              yield {
                type: "tool-call-start",
                index,
                id: state.id,
                name: state.name,
              };
              for (const argumentsDelta of state.pendingArguments) {
                yield {
                  type: "tool-call-delta",
                  index,
                  argumentsDelta,
                };
              }
              state.pendingArguments = [];
            }
            yield { type: "tool-call-end", index };
          }
          endedTools = true;
        }
        yield {
          type: "finish",
          reason: toFinishReason(choice.finish_reason),
        };
      }
    }

    if (!sawFinish) {
      throw new CixCodeError(
        "PROVIDER_RESPONSE_INVALID",
        "Provider stream ended without a finish reason",
      );
    }
  }

  private async request(
    request: LLMRequest,
    signal: AbortSignal,
  ): Promise<Response> {
    const body = JSON.stringify({
      model: this.model,
      messages: request.messages.map(toOpenAIMessage),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }
        : {}),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    });

    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw new AgentAbortedError(signal.reason);
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: this.headers,
          body,
          signal,
        });
        if (!response.ok) {
          const failure = await toHttpFailure(response);
          if (failure.retryable && attempt < this.maxRetries) {
            await wait(failure.retryAfterMs ?? backoff(attempt), signal);
            continue;
          }
          throw failure.error;
        }
        return response;
      } catch (error) {
        if (isAbortError(error)) throw new AgentAbortedError(error);
        if (error instanceof CixCodeError) throw error;
        if (attempt < this.maxRetries) {
          await wait(backoff(attempt), signal);
          continue;
        }
        throw new CixCodeError(
          "PROVIDER_REQUEST_FAILED",
          error instanceof Error ? error.message : "Provider request failed",
          { cause: error },
        );
      }
    }
  }
}

function toOpenAIMessage(message: Message): Record<string, unknown> {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      ...(message.toolCalls?.length
        ? {
            tool_calls: message.toolCalls.map((call: ToolCall) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: call.arguments,
              },
            })),
          }
        : {}),
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      name: message.name,
      content: message.content,
    };
  }
  return { role: message.role, content: message.content };
}

function toUsage(usage: NonNullable<OpenAIChunk["usage"]>): Usage {
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
  };
}

function toFinishReason(reason: string): FinishReason {
  switch (reason) {
    case "stop":
    case "tool_calls":
    case "length":
    case "content_filter":
      return reason;
    default:
      throw new CixCodeError(
        "PROVIDER_RESPONSE_INVALID",
        `Unknown finish reason: ${reason}`,
      );
  }
}

async function toHttpFailure(
  response: Response,
): Promise<{ error: CixCodeError; retryable: boolean; retryAfterMs?: number }> {
  const text = await response.text();
  let message = `Provider request failed with status ${response.status}`;
  try {
    const body = JSON.parse(text) as { error?: { message?: string } };
    if (body.error?.message) message = body.error.message;
  } catch {
    if (text) message = text.slice(0, 500);
  }

  const retryable = response.status === 429 || response.status >= 500;
  const error = new CixCodeError(
    response.status === 401 || response.status === 403
      ? "PROVIDER_AUTH_FAILED"
      : response.status === 429
        ? "PROVIDER_RATE_LIMITED"
        : "PROVIDER_REQUEST_FAILED",
    message,
  );
  const retryAfter = response.headers.get("retry-after");
  const retryAfterMs = retryAfter ? parseRetryAfter(retryAfter) : undefined;
  return { error, retryable, retryAfterMs };
}

function parseRetryAfter(value: string): number | undefined {
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function backoff(attempt: number): number {
  return 250 * 2 ** attempt;
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new AgentAbortedError(signal.reason);
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AgentAbortedError(signal.reason));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
