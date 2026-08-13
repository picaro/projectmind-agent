export type RunnerLog = (
  message: string,
  kind?: "log" | "error" | "status",
) => void | Promise<void>;

export type RunnerInput = {
  cwd: string;
  prompt: string;
  onLog: RunnerLog;
  signal: AbortSignal;
  /** Job wall-clock budget in milliseconds, when supplied by the queue. */
  timeoutMs?: number;
};

/** Token usage / cost / timing reported by the underlying CLI, when it exposes one. */
export type RunnerUsageStats = {
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};

export type RunnerResult = {
  status: "succeeded" | "failed" | "cancelled";
  summary: string;
  error?: string;
  externalRunId?: string;
  /** Resolved model id/name used for this run (for usage stats). */
  model?: string;
  /** Usage stats self-reported by the CLI (e.g. Claude Code's stream-json result event). */
  stats?: RunnerUsageStats;
};

export type RunnerName =
  | "auto"
  | "cursor_sdk"
  | "cursor_cli"
  | "codex_cli"
  | "antigravity_cli"
  | "claude_cli"
  | "copilot_cli"
  | "openrouter"
  | "tokenrouter";

export type Runner = {
  name: Exclude<RunnerName, "auto">;
  run(input: RunnerInput): Promise<RunnerResult>;
};
