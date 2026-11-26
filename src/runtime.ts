import { Agent, type AgentOptions } from "./agent/agent.js";
import { ToolRunner } from "./agent/tool-runner.js";
import { EventBus } from "./core/events.js";
import type { Logger } from "./core/logger.js";
import { noopLogger } from "./core/logger.js";
import type { AgentEvent, RunInput, Tool } from "./core/types.js";
import { openAICompatiblePlugin } from "./llm/openai-compatible/plugin.js";
import type { LLMProvider } from "./llm/provider.js";
import { PluginHost } from "./plugins/host.js";
import type {
  LLMProviderPlugin,
  PluginConfig,
  PluginDefinition,
} from "./plugins/types.js";

export interface RuntimeAgentOptions extends AgentOptions {
  tools?: Tool[];
  toolTimeoutMs?: number;
  maxToolOutputChars?: number;
}

export interface RuntimeConfig {
  plugins: PluginConfig[];
  agent: RuntimeAgentOptions;
  logger?: Logger;
}

export interface CixRuntime {
  readonly events: EventBus;
  readonly plugins: PluginHost;
  run(input: RunInput): AsyncIterable<AgentEvent>;
  dispose(): Promise<void>;
}

export async function createRuntime(
  config: RuntimeConfig,
  definitions: PluginDefinition[] = [openAICompatiblePlugin],
): Promise<CixRuntime> {
  const logger = config.logger ?? noopLogger;
  const controller = new AbortController();
  const events = new EventBus(logger);
  const toolRunner = new ToolRunner({
    timeoutMs: config.agent.toolTimeoutMs,
    maxOutputChars: config.agent.maxToolOutputChars,
    logger,
  });

  for (const tool of config.agent.tools ?? []) {
    toolRunner.register(tool);
  }

  const plugins = new PluginHost(
    {
      events,
      registerTool: (tool) => toolRunner.register(tool),
    },
    logger,
    controller.signal,
  );

  for (const definition of definitions) {
    plugins.register(definition);
  }

  await plugins.load(config.plugins);
  const providerPlugin = plugins.resolve<LLMProviderPlugin>("llm-provider");
  const provider: LLMProvider = providerPlugin.createProvider();
  const {
    tools: _tools,
    toolTimeoutMs: _toolTimeoutMs,
    maxToolOutputChars: _maxToolOutputChars,
    ...agentOptions
  } = config.agent;
  const agent = new Agent(provider, toolRunner, agentOptions);
  let disposed = false;

  return {
    events,
    plugins,
    async *run(input) {
      const signal = input.signal
        ? AbortSignal.any([input.signal, controller.signal])
        : controller.signal;
      for await (const event of agent.run({ ...input, signal })) {
        await events.emit(event);
        yield event;
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      await plugins.dispose();
    },
  };
}
