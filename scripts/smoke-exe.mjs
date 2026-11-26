import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const executable = path.join(
  root,
  "dist-bin",
  process.platform === "win32" ? "cixcode.exe" : "cixcode",
);
const workDirectory = mkdtempSync(path.join(tmpdir(), "cixcode-exe-"));
const configDirectory = path.join(workDirectory, ".cixcode");
const configPath = path.join(configDirectory, "settings.json");
mkdirSync(configDirectory);

let requestCount = 0;
let sawToolResult = false;

const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  requestCount += 1;

  assert.equal(body.model, "smoke-model");
  assert.equal(body.stream, true);
  assert.equal(request.headers.authorization, "Bearer smoke-key");

  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const sawToolMessage = body.messages.some(
    (message) => message.role === "tool",
  );
  if (!sawToolMessage) {
    assert.equal(requestCount, 1);
    response.write(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-time","function":{"name":"get_time","arguments":"{}"}}]}}]}\n\n',
    );
    response.write(
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    );
  } else {
    assert.equal(requestCount, 2);
    const toolMessage = body.messages.find(
      (message) => message.role === "tool",
    );
    assert.equal(toolMessage.tool_call_id, "call-time");
    assert.match(toolMessage.content, /"utc":"/);
    sawToolResult = true;
    response.write(
      'data: {"choices":[{"delta":{"content":"SEA tool call "}}]}\n\n',
    );
    response.write(
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
    );
  }
  response.write("data: [DONE]\n\n");
  response.end();
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  writeFileSync(
    configPath,
    JSON.stringify({
      llm: { baseUrl, apiKey: "smoke-key", model: "smoke-model" },
    }),
  );
  const env = {
    ...process.env,
    HOME: workDirectory,
    USERPROFILE: workDirectory,
  };

  const child = spawn(executable, ["What time is it?"], {
    cwd: workDirectory,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const timeout = setTimeout(() => child.kill(), 15_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, stderr);
  } finally {
    clearTimeout(timeout);
  }

  assert.equal(requestCount, 2);
  assert.equal(sawToolResult, true);
  assert.match(stdout, /SEA tool call ok/);
  assert.match(stderr, /\[tool\] get_time/);
  console.log("Standalone executable smoke test passed.");
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  rmSync(workDirectory, { recursive: true, force: true });
}
