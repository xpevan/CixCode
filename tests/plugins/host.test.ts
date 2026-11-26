import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/core/events.js";
import { PluginHost } from "../../src/plugins/host.js";
import type {
  Plugin,
  PluginDefinition,
  PluginManifest,
  PluginServices,
  PluginType,
} from "../../src/plugins/types.js";

function createHost(): {
  host: PluginHost;
  services: PluginServices;
} {
  const services: PluginServices = {
    events: new EventBus(),
    registerTool() {},
  };
  return {
    services,
    host: new PluginHost(services),
  };
}

function createDefinition(
  id: string,
  type: PluginType = "memory",
  overrides: Partial<PluginManifest> = {},
): PluginDefinition {
  const manifest: PluginManifest = {
    id,
    type,
    version: "1.0.0",
    apiVersion: 1,
    ...overrides,
  };
  return {
    manifest,
    create() {
      const plugin: Plugin = {
        manifest,
        init: vi.fn(),
        dispose: vi.fn(),
      };
      return plugin;
    },
  };
}

describe("PluginHost", () => {
  it("loads plugins and resolves capabilities by priority", async () => {
    const { host, services } = createHost();
    host.register(createDefinition("memory-a"));
    host.register(createDefinition("memory-b"));

    await host.load([
      { id: "memory-a", type: "memory", priority: 20 },
      { id: "memory-b", type: "memory", priority: 10 },
    ]);

    expect(
      host.resolveAll<Plugin>("memory").map((plugin) => plugin.manifest.id),
    ).toEqual(["memory-b", "memory-a"]);
    expect(services.events).toBeInstanceOf(EventBus);
    await host.dispose();
  });

  it("rejects duplicate plugin definitions", () => {
    const { host } = createHost();
    host.register(createDefinition("duplicate"));

    expect(() => host.register(createDefinition("duplicate"))).toThrowError(
      /Duplicate plugin definition/,
    );
  });

  it("rejects unsupported API versions", () => {
    const { host } = createHost();

    expect(() =>
      host.register(
        createDefinition("future", "memory", { apiVersion: 2 as 1 }),
      ),
    ).toThrowError(/Unsupported plugin API version/);
  });

  it("rejects missing dependencies", async () => {
    const { host } = createHost();
    host.register(createDefinition("dependent", "memory", { dependencies: ["base"] }));

    await expect(
      host.load([{ id: "dependent", type: "memory" }]),
    ).rejects.toMatchObject({ code: "PLUGIN_DEPENDENCY_MISSING" });
  });

  it("rejects multiple singleton providers", async () => {
    const { host } = createHost();
    host.register(createDefinition("provider-a", "llm-provider"));
    host.register(createDefinition("provider-b", "llm-provider"));

    await expect(
      host.load([
        { id: "provider-a", type: "llm-provider" },
        { id: "provider-b", type: "llm-provider" },
      ]),
    ).rejects.toMatchObject({ code: "PLUGIN_CAPABILITY_CONFLICT" });
  });

  it("validates plugin configuration", async () => {
    const { host } = createHost();
    host.register(
      createDefinition("configured", "memory", {
        configSchema: {
          type: "object",
          required: ["limit"],
          properties: { limit: { type: "integer", minimum: 1 } },
        },
      }),
    );

    await expect(
      host.load([
        { id: "configured", type: "memory", config: { limit: 0 } },
      ]),
    ).rejects.toMatchObject({ code: "PLUGIN_CONFIG_INVALID" });
  });

  it("disposes plugins in reverse initialization order", async () => {
    const order: string[] = [];
    const { host } = createHost();
    for (const id of ["first", "second"]) {
      const definition = createDefinition(id);
      definition.create = () => ({
        manifest: definition.manifest,
        init() {},
        dispose() {
          order.push(id);
        },
      });
      host.register(definition);
    }

    await host.load([
      { id: "first", type: "memory" },
      { id: "second", type: "memory" },
    ]);
    await host.dispose();

    expect(order).toEqual(["second", "first"]);
  });
});
