import { describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent.js";
import { ToolRunner } from "../../src/agent/tool-runner.js";
import { AgentAbortedError, CixCodeError } from "../../src/core/errors.js";
import type { AgentEvent, Tool } from "../../src/core/types.js";
import { FakeProvider, textEvents, toolCallEvents } from "../fake-provider.js";

const echoTool: Tool = {
  name: "echo",
  description: "Echo a value",
  parameters: {
    type: "object",
    required: ["value"],
    additionalProperties: false,
    properties: { value: { type: "string" } },
  },
  execute(args) {
    return args;
  },
};

async function collect(
  iterable: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("Agent", () => {
  it("completes a plain text response in one step", async () => {
    const provider = new FakeProvider([textEvents("Hello")]);
    const agent = new Agent(provider, new ToolRunner());

    const events = await collect(
      agent.run({ messages: [{ role: "user", content: "Hi" }] }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "step-start",
      "text-delta",
      "done",
    ]);
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.result.status).toBe("completed");
      expect(done.result.messages.at(-1)).toEqual({
        role: "assistant",
        content: "Hello",
        toolCalls: [],
      });
      expect(done.result.usage).toEqual({
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      });
    }
  });

  it("executes a tool call and sends the result back to the model", async () => {
    const provider = new FakeProvider([
      toolCallEvents([
        { id: "call-1", name: "echo", arguments: '{"value":"hello"}' },
      ]),
      textEvents("Tool completed"),
    ]);
    const runner = new ToolRunner();
    runner.register(echoTool);
    const agent = new Agent(provider, runner);

    const events = await collect(
      agent.run({ messages: [{ role: "user", content: "Echo hello" }] }),
    );

    expect(events.some((event) => event.type === "tool-start")).toBe(true);
    expect(events.some((event) => event.type === "tool-end")).toBe(true);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1].messages).toEqual([
      { role: "user", content: "Echo hello" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-1", name: "echo", arguments: '{"value":"hello"}' },
        ],
      },
      expect.objectContaining({
        role: "tool",
        toolCallId: "call-1",
        name: "echo",
      }),
    ]);
  });

  it("executes multiple tool calls in model order", async () => {
    const order: string[] = [];
    const makeTool = (name: string): Tool => ({
      ...echoTool,
      name,
      execute() {
        order.push(name);
        return name;
      },
    });
    const runner = new ToolRunner();
    runner.register(makeTool("first"));
    runner.register(makeTool("second"));
    const provider = new FakeProvider([
      toolCallEvents([
        { id: "call-1", name: "first", arguments: '{"value":"a"}' },
        { id: "call-2", name: "second", arguments: '{"value":"b"}' },
      ]),
      textEvents("Done"),
    ]);
    const agent = new Agent(provider, runner);

    await collect(
      agent.run({ messages: [{ role: "user", content: "Run both" }] }),
    );

    expect(order).toEqual(["first", "second"]);
  });

  it("stops at maxSteps", async () => {
    const script = toolCallEvents([
      { id: "call-1", name: "echo", arguments: '{"value":"again"}' },
    ]);
    const provider = new FakeProvider([script, script]);
    const runner = new ToolRunner();
    runner.register(echoTool);
    const agent = new Agent(provider, runner, { maxSteps: 2 });

    const events = await collect(
      agent.run({ messages: [{ role: "user", content: "Loop" }] }),
    );
    const done = events.at(-1);

    expect(provider.requests).toHaveLength(2);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.result.status).toBe("max_steps");
    }
  });

  it("rejects when the provider omits a finish event", async () => {
    const provider = new FakeProvider([
      [{ type: "text-delta", delta: "Incomplete" }],
    ]);
    const agent = new Agent(provider, new ToolRunner());

    await expect(
      collect(agent.run({ messages: [{ role: "user", content: "Hi" }] })),
    ).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
  });

  it("propagates cancellation", async () => {
    const provider = new FakeProvider([textEvents("Hello")]);
    const agent = new Agent(provider, new ToolRunner());
    const controller = new AbortController();
    controller.abort();

    await expect(
      collect(
        agent.run({
          messages: [{ role: "user", content: "Hi" }],
          signal: controller.signal,
        }),
      ),
    ).rejects.toBeInstanceOf(AgentAbortedError);
  });

  it("adds a system prompt without mutating input messages", async () => {
    const provider = new FakeProvider([textEvents("Hello")]);
    const agent = new Agent(provider, new ToolRunner(), {
      systemPrompt: "Be concise",
    });
    const input = [{ role: "user" as const, content: "Hi" }];

    await collect(agent.run({ messages: input }));

    expect(input).toEqual([{ role: "user", content: "Hi" }]);
    expect(provider.requests[0].messages[0]).toEqual({
      role: "system",
      content: "Be concise",
    });
  });

  it("surfaces provider errors", async () => {
    const provider = new FakeProvider([
      async function* () {
        throw new CixCodeError("PROVIDER_AUTH_FAILED", "Unauthorized");
      },
    ]);
    const agent = new Agent(provider, new ToolRunner());

    await expect(
      collect(agent.run({ messages: [{ role: "user", content: "Hi" }] })),
    ).rejects.toMatchObject({ code: "PROVIDER_AUTH_FAILED" });
  });
});
