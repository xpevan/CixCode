import { describe, expect, it } from "vitest";
import type { AgentEvent, Tool } from "../src/core/types.js";
import { createRuntime } from "../src/runtime.js";
import type {
  LLMProviderPlugin,
  PluginDefinition,
} from "../src/plugins/types.js";
import { FakeProvider, textEvents, toolCallEvents } from "./fake-provider.js";

const echoTool: Tool = {
  name: "echo",
  description: "Echo",
  parameters: {
    type: "object",
    required: ["value"],
    properties: { value: { type: "string" } },
  },
  execute(args) {
    return args;
  },
};

function providerDefinition(provider: FakeProvider): PluginDefinition {
  const manifest = {
    id: "fake-provider",
    type: "llm-provider" as const,
    version: "1.0.0",
    apiVersion: 1 as const,
  };
  const plugin: LLMProviderPlugin = {
    manifest,
    init() {},
    createProvider() {
      return provider;
    },
    dispose() {},
  };
  return { manifest, create: () => plugin };
}

async function collect(
  iterable: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("createRuntime", () => {
  it("assembles plugins, tools, and the agent loop", async () => {
    const provider = new FakeProvider([
      toolCallEvents([
        { id: "call-1", name: "echo", arguments: '{"value":"hello"}' },
      ]),
      textEvents("Done"),
    ]);
    const runtime = await createRuntime(
      {
        plugins: [{ id: "fake-provider", type: "llm-provider" }],
        agent: { tools: [echoTool], maxSteps: 3 },
      },
      [providerDefinition(provider)],
    );
    const observed: string[] = [];
    runtime.events.subscribe((event) => {
      observed.push(event.type);
    });

    try {
      const events = await collect(
        runtime.run({
          messages: [{ role: "user", content: "Echo hello" }],
        }),
      );

      expect(events.some((event) => event.type === "tool-end")).toBe(true);
      expect(observed).toContain("tool-end");
      expect(provider.requests).toHaveLength(2);
    } finally {
      await runtime.dispose();
    }
  });

  it("requires an LLM provider plugin", async () => {
    await expect(
      createRuntime({
        plugins: [],
        agent: {},
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_NOT_FOUND" });
  });
});
