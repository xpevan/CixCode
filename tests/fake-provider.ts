import { CixCodeError } from "../src/core/errors.js";
import type {
  LLMEvent,
  LLMRequest,
  ToolCall,
  Usage,
} from "../src/core/types.js";
import type { LLMProvider } from "../src/llm/provider.js";

export class FakeProvider implements LLMProvider {
  readonly model = "fake-model";
  readonly requests: LLMRequest[] = [];

  constructor(
    private readonly scripts: Array<
      LLMEvent[] | ((request: LLMRequest, signal: AbortSignal) => AsyncIterable<LLMEvent>)
    >,
  ) {}

  async *stream(
    request: LLMRequest,
    signal: AbortSignal,
  ): AsyncIterable<LLMEvent> {
    this.requests.push(request);
    const script = this.scripts[this.requests.length - 1];
    if (!script) {
      throw new CixCodeError(
        "PROVIDER_RESPONSE_INVALID",
        "No fake provider script configured",
      );
    }
    if (typeof script === "function") {
      yield* script(request, signal);
      return;
    }
    for (const event of script) {
      if (signal.aborted) throw new Error("Aborted");
      yield event;
    }
  }
}

export function textEvents(
  text: string,
  usage: Usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
): LLMEvent[] {
  return [
    { type: "text-delta", delta: text },
    { type: "usage", usage },
    { type: "finish", reason: "stop" },
  ];
}

export function toolCallEvents(
  calls: ToolCall[],
  usage: Usage = { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
): LLMEvent[] {
  const events: LLMEvent[] = calls.flatMap((call, index) => [
    {
      type: "tool-call-start" as const,
      index,
      id: call.id,
      name: call.name,
    },
    {
      type: "tool-call-delta" as const,
      index,
      argumentsDelta: call.arguments,
    },
    { type: "tool-call-end" as const, index },
  ]);
  events.push({ type: "usage", usage });
  events.push({ type: "finish", reason: "tool_calls" });
  return events;
}
