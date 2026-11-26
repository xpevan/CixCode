import type { EventBus } from "../core/events.js";
import type { JSONSchema, Tool } from "../core/types.js";
import type { LLMProvider } from "../llm/provider.js";

export type PluginType =
  | "llm-provider"
  | "tui"
  | "memory"
  | "compression"
  | "tool-provider";

export interface PluginManifest {
  id: string;
  type: PluginType;
  version: string;
  apiVersion: 1;
  entry?: string;
  dependencies?: string[];
  configSchema?: JSONSchema;
}

export interface PluginServices {
  events: EventBus;
  registerTool(tool: Tool): void;
}

export interface PluginContext {
  config: unknown;
  logger: PluginContextLogger;
  signal: AbortSignal;
  services: PluginServices;
}

export interface PluginContextLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface Plugin {
  readonly manifest: PluginManifest;
  init(context: PluginContext): Promise<void> | void;
  dispose(): Promise<void> | void;
}

export interface PluginDefinition {
  manifest: PluginManifest;
  create(context: PluginContext): Promise<Plugin> | Plugin;
}

export interface PluginConfig {
  id: string;
  type: PluginType;
  enabled?: boolean;
  priority?: number;
  config?: unknown;
}

export interface LLMProviderPlugin extends Plugin {
  createProvider(): LLMProvider;
}
