import type { LLMEvent, LLMRequest } from "../core/types.js";

export interface LLMProvider {
  readonly model: string;
  stream(
    request: LLMRequest,
    signal: AbortSignal,
  ): AsyncIterable<LLMEvent>;
}
