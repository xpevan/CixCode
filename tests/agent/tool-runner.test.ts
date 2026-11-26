import { describe, expect, it } from "vitest";
import { ToolRunner } from "../../src/agent/tool-runner.js";
import { AgentAbortedError } from "../../src/core/errors.js";
import type { Tool } from "../../src/core/types.js";

function createEchoTool(): Tool {
  return {
    name: "echo",
    description: "Echo a value",
    parameters: {
      type: "object",
      required: ["value"],
      additionalProperties: false,
      properties: {
        value: { type: "string" },
      },
    },
    execute(args) {
      return args;
    },
  };
}

describe("ToolRunner", () => {
  it("executes a tool and returns a tool message", async () => {
    const runner = new ToolRunner();
    runner.register(createEchoTool());

    const execution = await runner.execute(
      { id: "call-1", name: "echo", arguments: '{"value":"hello"}' },
      new AbortController().signal,
    );

    expect(execution.result.ok).toBe(true);
    expect(execution.message).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
      name: "echo",
    });
    expect(JSON.parse(execution.message.content!)).toEqual({
      ok: true,
      data: { value: "hello" },
    });
  });

  it("returns an error for malformed JSON arguments", async () => {
    const runner = new ToolRunner();
    runner.register(createEchoTool());

    const execution = await runner.execute(
      { id: "call-1", name: "echo", arguments: "{" },
      new AbortController().signal,
    );

    expect(execution.result.ok).toBe(false);
    expect(execution.result.error?.code).toBe("TOOL_ARGUMENTS_INVALID");
  });

  it("validates arguments against the tool schema", async () => {
    const runner = new ToolRunner();
    runner.register(createEchoTool());

    const execution = await runner.execute(
      { id: "call-1", name: "echo", arguments: '{"value":123}' },
      new AbortController().signal,
    );

    expect(execution.result.error?.code).toBe("TOOL_ARGUMENTS_INVALID");
  });

  it("returns an error for an unknown tool", async () => {
    const runner = new ToolRunner();
    const execution = await runner.execute(
      { id: "call-1", name: "missing", arguments: "{}" },
      new AbortController().signal,
    );

    expect(execution.result.error?.code).toBe("TOOL_NOT_FOUND");
  });

  it("converts tool execution errors into tool results", async () => {
    const runner = new ToolRunner();
    runner.register({
      ...createEchoTool(),
      execute() {
        throw new Error("boom");
      },
    });

    const execution = await runner.execute(
      { id: "call-1", name: "echo", arguments: '{"value":"hello"}' },
      new AbortController().signal,
    );

    expect(execution.result.error).toEqual({
      code: "TOOL_EXECUTION_FAILED",
      message: "boom",
    });
  });

  it("times out a tool that observes cancellation", async () => {
    const runner = new ToolRunner({ timeoutMs: 5 });
    runner.register({
      ...createEchoTool(),
      execute(_args, { signal }) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    });

    const execution = await runner.execute(
      { id: "call-1", name: "echo", arguments: '{"value":"hello"}' },
      new AbortController().signal,
    );

    expect(execution.result.error?.code).toBe("TOOL_TIMEOUT");
  });

  it("truncates large tool output", async () => {
    const runner = new ToolRunner({ maxOutputChars: 10 });
    runner.register({
      ...createEchoTool(),
      execute() {
        return "x".repeat(100);
      },
    });

    const execution = await runner.execute(
      { id: "call-1", name: "echo", arguments: '{"value":"hello"}' },
      new AbortController().signal,
    );

    expect(JSON.parse(execution.message.content!)).toMatchObject({
      ok: true,
      truncated: true,
    });
  });

  it("propagates external cancellation", async () => {
    const runner = new ToolRunner();
    runner.register(createEchoTool());
    const controller = new AbortController();
    controller.abort();

    await expect(
      runner.execute(
        { id: "call-1", name: "echo", arguments: '{"value":"hello"}' },
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(AgentAbortedError);
  });
});
