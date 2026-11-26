# CixCode

A minimal, high-performance and highly extensible agent runtime for LLM tool orchestration.

The first implementation provides a plugin host, an OpenAI-compatible streaming provider, an agent loop, and tool calling.

## Install

```bash
npm install
```

## Run

Create `~/.cixcode/settings.json` in the user home directory (`C:\Users\<name>\.cixcode\settings.json` on Windows):

```json
{
  "llm": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "your-api-key",
    "model": "gpt-4o-mini"
  }
}
```

This keeps credentials outside the repository. The base URL may point to any OpenAI-compatible Chat Completions endpoint.

```bash
npm run cli -- "What time is it?"
```

Run the fixed-prompt smoke check against the configured provider with:

```bash
npm run smoke
```

## Windows executable

Build a standalone executable with the Node.js Single Executable Application (SEA) toolchain:

```bash
npm run build:exe
```

The output is `dist-bin/cixcode.exe`. It includes the runtime and dependencies, so the target machine does not need Node.js installed.

The executable reads the same user-level `~/.cixcode/settings.json` file, then run:

```bat
dist-bin\cixcode.exe "What time is it?"
dist-bin\cixcode.exe --help
```

The executable can also read a prompt from standard input:

```bat
echo What time is it? | dist-bin\cixcode.exe
```

Build and run the local mock-server smoke test with:

```bash
npm run test:exe
```

The generated executable is unsigned. Configure Authenticode signing separately if required for distribution.

## Development

```bash
npm run typecheck
npm test
npm run build
```

## Public API

```ts
import { createRuntime, loadLLMConfig } from "cixcode";

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
    maxSteps: 8,
    tools: [],
  },
});

for await (const event of runtime.run({
  messages: [{ role: "user", content: "Hello" }],
})) {
  console.log(event);
}

await runtime.dispose();
```

See [the design document](docs/agent-runtime-design.md) for architecture and extension boundaries.
