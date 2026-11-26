import { loadLLMConfig } from "./config.js";
import { CixCodeError } from "./core/errors.js";
import type { Tool } from "./core/types.js";
import { createRuntime, type CixRuntime } from "./runtime.js";

const getTime: Tool = {
  name: "get_time",
  description: "Get the current UTC time",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  execute() {
    return { utc: new Date().toISOString() };
  },
};

let activeRuntime: CixRuntime | undefined;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const prompt = await readPrompt(args);
  if (!prompt) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const llm = await loadLLMConfig();

  const runtime = await createRuntime({
    plugins: [
      {
        id: "openai-compatible",
        type: "llm-provider",
        config: llm,
      },
    ],
    agent: {
      tools: [getTime],
      maxSteps: 8,
    },
  });
  activeRuntime = runtime;

  try {
    for await (const event of runtime.run({
      messages: [{ role: "user", content: prompt }],
    })) {
      switch (event.type) {
        case "text-delta":
          process.stdout.write(event.delta);
          break;
        case "tool-start":
          process.stderr.write(`\n[tool] ${event.call.name}\n`);
          break;
        case "tool-end":
          process.stderr.write(`[tool] ${event.result.content}\n`);
          break;
        case "done":
          if (event.result.messages.at(-1)?.role === "assistant") {
            process.stdout.write("\n");
          }
          break;
      }
    }
  } finally {
    await runtime.dispose();
    activeRuntime = undefined;
  }
}

async function readPrompt(args: string[]): Promise<string> {
  if (args.length > 0) return args.join(" ").trim();
  if (process.stdin.isTTY) return "";

  const chunks: string[] = [];
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  return chunks.join("").trim();
}

function printUsage(): void {
  process.stdout.write(`CixCode CLI

Usage:
  cixcode "<prompt>"
  echo "<prompt>" | cixcode
  cixcode --help

Config:
  ~/.cixcode/settings.json   LLM base URL, API key and model
`);
}

process.on("SIGINT", () => {
  if (activeRuntime) void activeRuntime.dispose();
});

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown CLI error";
  const code = error instanceof CixCodeError ? ` [${error.code}]` : "";
  process.stderr.write(`cixcode:${code} ${message}\n`);
  process.exitCode = 1;
});
