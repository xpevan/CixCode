export type JSONSchema = Record<string, unknown>;

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface Message {
  role: Role;
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface ToolContext {
  signal: AbortSignal;
  toolCallId: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  execute(args: unknown, context: ToolContext): unknown | Promise<unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export type FinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface LLMRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export type LLMEvent =
  | { type: "text-delta"; delta: string }
  | {
      type: "tool-call-start";
      index: number;
      id: string;
      name: string;
    }
  | {
      type: "tool-call-delta";
      index: number;
      argumentsDelta: string;
    }
  | { type: "tool-call-end"; index: number }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; reason: FinishReason };

export interface ToolExecutionResult {
  ok: boolean;
  content: string;
  error?: {
    code: string;
    message: string;
  };
}

export type AgentEvent =
  | { type: "step-start"; step: number }
  | { type: "text-delta"; delta: string }
  | { type: "tool-start"; call: ToolCall }
  | {
      type: "tool-end";
      call: ToolCall;
      result: ToolExecutionResult;
    }
  | { type: "done"; result: AgentResult };

export interface AgentResult {
  status: "completed" | "max_steps";
  messages: Message[];
  usage: Usage;
  finishReason?: FinishReason;
}

export interface RunInput {
  messages: Message[];
  signal?: AbortSignal;
}

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}
