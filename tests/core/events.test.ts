import { describe, expect, it } from "vitest";
import { EventBus } from "../../src/core/events.js";

describe("EventBus", () => {
  it("notifies subscribers and supports unsubscribe", async () => {
    const bus = new EventBus();
    const received: string[] = [];
    const unsubscribe = bus.subscribe((event) => {
      received.push(event.type);
    });

    await bus.emit({ type: "step-start", step: 1 });
    unsubscribe();
    await bus.emit({ type: "step-start", step: 2 });

    expect(received).toEqual(["step-start"]);
  });

  it("isolates listener failures", async () => {
    const bus = new EventBus();
    const received: string[] = [];
    bus.subscribe(() => {
      throw new Error("listener failed");
    });
    bus.subscribe((event) => {
      received.push(event.type);
    });

    await expect(bus.emit({ type: "step-start", step: 1 })).resolves.toBeUndefined();
    expect(received).toEqual(["step-start"]);
  });
});
