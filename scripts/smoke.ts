import { loadLLMConfig } from "../src/config.js";
import { createRuntime, type Tool } from "../src/index.js";

const llm = await loadLLMConfig();

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
    maxSteps: 4,
  },
});

try {
  for await (const event of runtime.run({
    messages: [
      {
        role: "user",
        content: "Use the get_time tool and tell me the current UTC time.",
      },
    ],
  })) {
    switch (event.type) {
      case "step-start":
        console.log(`\nStep ${event.step}`);
        break;
      case "text-delta":
        process.stdout.write(event.delta);
        break;
      case "tool-start":
        console.log(`\nTool: ${event.call.name}`);
        break;
      case "tool-end":
        console.log(`Tool result: ${event.result.content}`);
        break;
      case "done":
        console.log(`\nStatus: ${event.result.status}`);
        console.log(`Usage: ${JSON.stringify(event.result.usage)}`);
        break;
    }
  }
} finally {
  await runtime.dispose();
}
