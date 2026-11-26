import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import { AgentAbortedError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import { noopLogger } from "../core/logger.js";
import type {
  Message,
  Tool,
  ToolCall,
  ToolDefinition,
  ToolExecutionResult,
} from "../core/types.js";

export interface ToolRunnerOptions {
  timeoutMs?: number;
  maxOutputChars?: number;
  logger?: Logger;
}

interface ToolEntry {
  tool: Tool;
  validate: ValidateFunction;
}

export interface ToolExecution {
  message: Message;
  result: ToolExecutionResult;
}

export class ToolRunner {
  private readonly entries = new Map<string, ToolEntry>();
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly timeoutMs: number;
  private readonly maxOutputChars: number;
  private readonly logger: Logger;

  constructor(options: ToolRunnerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxOutputChars = options.maxOutputChars ?? 16_000;
    this.logger = options.logger ?? noopLogger;
  }

  register(tool: Tool): void {
    if (this.entries.has(tool.name)) {
      throw new Error(`Duplicate tool: ${tool.name}`);
    }
    const validate = this.ajv.compile(tool.parameters);
    this.entries.set(tool.name, { tool, validate });
  }

  get definitions(): ToolDefinition[] {
    return [...this.entries.values()].map(({ tool }) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  async executeAll(
    calls: ToolCall[],
    signal: AbortSignal,
  ): Promise<ToolExecution[]> {
    const executions: ToolExecution[] = [];
    for (const call of calls) {
      executions.push(await this.execute(call, signal));
    }
    return executions;
  }

  async execute(
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<ToolExecution> {
    if (signal.aborted) throw new AgentAbortedError(signal.reason);

    const entry = this.entries.get(call.name);
    if (!entry) {
      return this.failure(call, "TOOL_NOT_FOUND", `Unknown tool: ${call.name}`);
    }

    let args: unknown;
    try {
      args = JSON.parse(call.arguments);
    } catch (error) {
      return this.failure(
        call,
        "TOOL_ARGUMENTS_INVALID",
        `Invalid JSON arguments: ${(error as Error).message}`,
      );
    }

    if (!entry.validate(args)) {
      return this.failure(
        call,
        "TOOL_ARGUMENTS_INVALID",
        this.ajv.errorsText(entry.validate.errors),
      );
    }

    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      const value = await entry.tool.execute(args, {
        signal: controller.signal,
        toolCallId: call.id,
      });
      return this.success(call, value);
    } catch (error) {
      if (signal.aborted) throw new AgentAbortedError(error);
      if (timedOut) {
        return this.failure(call, "TOOL_TIMEOUT", "Tool execution timed out");
      }
      this.logger.error(`Tool execution failed: ${call.name}`, error);
      return this.failure(
        call,
        "TOOL_EXECUTION_FAILED",
        error instanceof Error ? error.message : "Tool execution failed",
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private success(call: ToolCall, value: unknown): ToolExecution {
    const serialized = JSON.stringify({ ok: true, data: value ?? null });
    const content =
      serialized.length > this.maxOutputChars
        ? JSON.stringify({
            ok: true,
            data: serialized.slice(0, this.maxOutputChars),
            truncated: true,
          })
        : serialized;
    const result: ToolExecutionResult = { ok: true, content };
    return {
      result,
      message: {
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content,
      },
    };
  }

  private failure(
    call: ToolCall,
    code: string,
    message: string,
  ): ToolExecution {
    const content = JSON.stringify({
      ok: false,
      error: {
        code,
        message: message.slice(0, this.maxOutputChars),
      },
    });
    const result: ToolExecutionResult = {
      ok: false,
      content,
      error: { code, message },
    };
    return {
      result,
      message: {
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content,
      },
    };
  }
}
