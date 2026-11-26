import { CixCodeError } from "../../core/errors.js";
import type {
  LLMProviderPlugin,
  PluginDefinition,
  PluginManifest,
} from "../../plugins/types.js";
import {
  OpenAICompatibleProvider,
  type OpenAICompatibleProviderOptions,
} from "./provider.js";

const manifest: PluginManifest = {
  id: "openai-compatible",
  type: "llm-provider",
  version: "0.1.0",
  apiVersion: 1,
  configSchema: {
    type: "object",
    additionalProperties: false,
    required: ["baseUrl", "apiKey", "model"],
    properties: {
      baseUrl: { type: "string", minLength: 1 },
      apiKey: { type: "string", minLength: 1 },
      model: { type: "string", minLength: 1 },
      defaultHeaders: {
        type: "object",
        additionalProperties: { type: "string" },
      },
      maxRetries: { type: "integer", minimum: 0 },
    },
  },
};

class OpenAICompatiblePlugin implements LLMProviderPlugin {
  readonly manifest = manifest;
  private provider?: OpenAICompatibleProvider;

  constructor(private readonly options: OpenAICompatibleProviderOptions) {}

  init(): void {
    this.provider = new OpenAICompatibleProvider(this.options);
  }

  createProvider(): OpenAICompatibleProvider {
    if (!this.provider) {
      throw new CixCodeError(
        "PLUGIN_INIT_FAILED",
        "OpenAI-compatible plugin is not initialized",
      );
    }
    return this.provider;
  }

  dispose(): void {
    this.provider = undefined;
  }
}

export const openAICompatiblePlugin: PluginDefinition = {
  manifest,
  create(context) {
    return new OpenAICompatiblePlugin(
      parseOptions(context.config),
    );
  },
};

function parseOptions(config: unknown): OpenAICompatibleProviderOptions {
  if (!isRecord(config)) {
    throw new CixCodeError("PLUGIN_CONFIG_INVALID", "Invalid plugin config");
  }
  const baseUrl = requiredString(config.baseUrl, "baseUrl");
  const apiKey = requiredString(config.apiKey, "apiKey");
  const model = requiredString(config.model, "model");
  const maxRetries = config.maxRetries;
  if (
    maxRetries !== undefined &&
    (typeof maxRetries !== "number" ||
      !Number.isInteger(maxRetries) ||
      maxRetries < 0)
  ) {
    throw new CixCodeError(
      "PLUGIN_CONFIG_INVALID",
      "maxRetries must be a non-negative integer",
    );
  }
  const defaultHeaders = config.defaultHeaders;
  if (defaultHeaders !== undefined && !isStringRecord(defaultHeaders)) {
    throw new CixCodeError(
      "PLUGIN_CONFIG_INVALID",
      "defaultHeaders must be an object of strings",
    );
  }
  return {
    baseUrl,
    apiKey,
    model,
    maxRetries,
    defaultHeaders,
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CixCodeError(
      "PLUGIN_CONFIG_INVALID",
      `${name} must be a non-empty string`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(
  value: unknown,
): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}
