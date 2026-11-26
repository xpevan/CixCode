import type { Logger } from "./logger.js";
import { noopLogger } from "./logger.js";
import type { AgentEvent } from "./types.js";

export type AgentEventListener = (
  event: AgentEvent,
) => void | Promise<void>;

export class EventBus {
  private readonly listeners = new Set<AgentEventListener>();

  constructor(private readonly logger: Logger = noopLogger) {}

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async emit(event: AgentEvent): Promise<void> {
    await Promise.all(
      [...this.listeners].map(async (listener) => {
        try {
          await listener(event);
        } catch (error) {
          this.logger.error("Agent event listener failed", error);
        }
      }),
    );
  }
}
