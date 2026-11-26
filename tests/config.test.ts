import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadLLMConfig } from "../src/config.js";

describe("loadLLMConfig", () => {
  let directory: string;
  let configPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "cixcode-config-"));
    configPath = path.join(directory, "settings.json");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("loads and trims LLM settings", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        llm: {
          baseUrl: " https://api.openai.com/v1 ",
          apiKey: " test-key ",
          model: " test-model ",
        },
      }),
    );

    await expect(loadLLMConfig(configPath)).resolves.toEqual({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      model: "test-model",
    });
  });

  it("reports a missing config file", async () => {
    await expect(loadLLMConfig(configPath)).rejects.toMatchObject({
      code: "AGENT_CONFIG_INVALID",
      message: expect.stringContaining(configPath),
    });
  });

  it("reports malformed JSON", async () => {
    await writeFile(configPath, "{");

    await expect(loadLLMConfig(configPath)).rejects.toMatchObject({
      code: "AGENT_CONFIG_INVALID",
      message: expect.stringContaining("Invalid JSON"),
    });
  });

  it("requires an llm object", async () => {
    await writeFile(configPath, JSON.stringify({ model: "test-model" }));

    await expect(loadLLMConfig(configPath)).rejects.toMatchObject({
      code: "AGENT_CONFIG_INVALID",
      message: 'Expected a "llm" object',
    });
  });

  it("requires non-empty string settings", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        llm: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: 42 },
      }),
    );

    await expect(loadLLMConfig(configPath)).rejects.toMatchObject({
      code: "AGENT_CONFIG_INVALID",
      message: '"llm.apiKey" must be a non-empty string',
    });
  });
});
