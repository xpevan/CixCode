import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { CixCodeError } from "./core/errors.js";

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export async function loadLLMConfig(
  filePath = path.join(homedir(), ".cixcode", "settings.json"),
): Promise<LLMConfig> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    throw new CixCodeError(
      "AGENT_CONFIG_INVALID",
      `Unable to read LLM config file: ${filePath}`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new CixCodeError(
      "AGENT_CONFIG_INVALID",
      `Invalid JSON in LLM config file: ${filePath}`,
      { cause: error },
    );
  }

  if (!isRecord(parsed) || !isRecord(parsed.llm)) {
    throw invalidConfig('Expected a "llm" object');
  }

  const llm = parsed.llm;
  return {
    baseUrl: requiredString(llm.baseUrl, "llm.baseUrl"),
    apiKey: requiredString(llm.apiKey, "llm.apiKey"),
    model: requiredString(llm.model, "llm.model"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidConfig(`"${key}" must be a non-empty string`);
  }
  return value.trim();
}

function invalidConfig(message: string): CixCodeError {
  return new CixCodeError("AGENT_CONFIG_INVALID", message);
}
