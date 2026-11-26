import { describe, expect, it, vi } from "vitest";
import type { LLMEvent, LLMRequest } from "../../src/core/types.js";
import { OpenAICompatibleProvider } from "../../src/llm/openai-compatible/provider.js";

const options = {
  baseUrl: "https://example.com/v1",
  apiKey: "test-key",
  model: "test-model",
  maxRetries: 0,
};

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function collect(
  provider: OpenAICompatibleProvider,
  request: LLMRequest = {
    messages: [{ role: "user", content: "Hello" }],
  },
): Promise<LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const event of provider.stream(
    request,
    new AbortController().signal,
  )) {
    events.push(event);
  }
  return events;
}

describe("OpenAICompatibleProvider", () => {
  it("parses streamed text, usage, and finish events", async () => {
    const fetchMock = vi.fn(async () =>
      streamResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\r\n\r\n',
        'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
        'data: {"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const provider = new OpenAICompatibleProvider(
      options,
      fetchMock as unknown as typeof fetch,
    );

    const events = await collect(provider);

    expect(events).toEqual([
      { type: "text-delta", delta: "Hel" },
      { type: "text-delta", delta: "lo" },
      { type: "finish", reason: "stop" },
      {
        type: "usage",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      },
    ]);
  });

  it("aggregates split tool call arguments", async () => {
    const fetchMock = vi.fn(async () =>
      streamResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"echo","arguments":"{\\"value\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"hi\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const provider = new OpenAICompatibleProvider(
      options,
      fetchMock as unknown as typeof fetch,
    );

    const events = await collect(provider);

    expect(events).toEqual([
      {
        type: "tool-call-start",
        index: 0,
        id: "call-1",
        name: "echo",
      },
      {
        type: "tool-call-delta",
        index: 0,
        argumentsDelta: '{"value":',
      },
      {
        type: "tool-call-delta",
        index: 0,
        argumentsDelta: '"hi"}',
      },
      { type: "tool-call-end", index: 0 },
      { type: "finish", reason: "tool_calls" },
    ]);
  });

  it("maps internal messages and tools to the request body", async () => {
    const fetchMock = vi.fn(async () =>
      streamResponse([
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const provider = new OpenAICompatibleProvider(
      options,
      fetchMock as unknown as typeof fetch,
    );

    await collect(provider, {
      messages: [
        { role: "user", content: "Use echo" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            { id: "call-1", name: "echo", arguments: '{"value":"hi"}' },
          ],
        },
        {
          role: "tool",
          toolCallId: "call-1",
          name: "echo",
          content: '{"ok":true}',
        },
      ],
      tools: [
        {
          name: "echo",
          description: "Echo",
          parameters: { type: "object" },
        },
      ],
      temperature: 0.2,
      maxTokens: 100,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://example.com/v1/chat/completions");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: "test-model",
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      max_tokens: 100,
      messages: [
        { role: "user", content: "Use echo" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "echo", arguments: '{"value":"hi"}' },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call-1",
          name: "echo",
          content: '{"ok":true}',
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "echo",
            description: "Echo",
            parameters: { type: "object" },
          },
        },
      ],
    });
  });

  it("rejects a stream without a finish event", async () => {
    const fetchMock = vi.fn(async () =>
      streamResponse([
        'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const provider = new OpenAICompatibleProvider(
      options,
      fetchMock as unknown as typeof fetch,
    );

    await expect(collect(provider)).rejects.toMatchObject({
      code: "PROVIDER_RESPONSE_INVALID",
    });
  });

  it("rejects malformed SSE JSON", async () => {
    const fetchMock = vi.fn(async () =>
      streamResponse(["data: not-json\n\n"]),
    );
    const provider = new OpenAICompatibleProvider(
      options,
      fetchMock as unknown as typeof fetch,
    );

    await expect(collect(provider)).rejects.toMatchObject({
      code: "PROVIDER_RESPONSE_INVALID",
    });
  });

  it("maps authentication failures", async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{"error":{"message":"bad key"}}', { status: 401 }),
    );
    const provider = new OpenAICompatibleProvider(
      options,
      fetchMock as unknown as typeof fetch,
    );

    await expect(collect(provider)).rejects.toMatchObject({
      code: "PROVIDER_AUTH_FAILED",
      message: "bad key",
    });
  });
});
