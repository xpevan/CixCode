export type ErrorCode =
  | "PLUGIN_MANIFEST_INVALID"
  | "PLUGIN_API_VERSION_MISMATCH"
  | "PLUGIN_DEPENDENCY_MISSING"
  | "PLUGIN_DEPENDENCY_CYCLE"
  | "PLUGIN_NOT_FOUND"
  | "PLUGIN_CONFIG_INVALID"
  | "PLUGIN_INIT_FAILED"
  | "PLUGIN_CAPABILITY_CONFLICT"
  | "PLUGIN_HOOK_FAILED"
  | "PROVIDER_AUTH_FAILED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_REQUEST_FAILED"
  | "PROVIDER_RESPONSE_INVALID"
  | "PROVIDER_STREAM_FAILED"
  | "AGENT_ABORTED"
  | "AGENT_CONFIG_INVALID"
  | "AGENT_RUNTIME_FAILED"
  | "TOOL_NOT_FOUND"
  | "TOOL_ARGUMENTS_INVALID"
  | "TOOL_TIMEOUT"
  | "TOOL_EXECUTION_FAILED";

export class CixCodeError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CixCodeError";
  }
}

export class AgentAbortedError extends CixCodeError {
  constructor(cause?: unknown) {
    super("AGENT_ABORTED", "Agent run was aborted", { cause });
    this.name = "AgentAbortedError";
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof AgentAbortedError ||
    (error instanceof CixCodeError && error.code === "AGENT_ABORTED") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function toCixCodeError(error: unknown): CixCodeError {
  if (error instanceof CixCodeError) return error;
  if (isAbortError(error)) return new AgentAbortedError(error);
  return new CixCodeError(
    "AGENT_RUNTIME_FAILED",
    error instanceof Error ? error.message : "Unknown runtime error",
    { cause: error },
  );
}
