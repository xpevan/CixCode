import { AgentAbortedError } from "../../core/errors.js";

export async function* readSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal.aborted) throw new AgentAbortedError(signal.reason);
      const { done, value } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });

      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const raw = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = extractData(raw);
        if (data !== undefined) yield data;
      }

      if (done) break;
    }

    if (buffer.trim()) {
      const data = extractData(buffer);
      if (data !== undefined) yield data;
    }
  } finally {
    reader.releaseLock();
  }
}

function extractData(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  return data.length > 0 ? data.join("\n") : undefined;
}
