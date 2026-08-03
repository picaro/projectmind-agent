/**
 * Conservative checks for llm_api `run_shell`.
 * Deny-list only — prefer Cursor/Codex runners when real sandboxing is needed.
 */

const MAX_COMMAND_CHARS = 2_000;

/** Binaries that reach the network or other hosts. */
const NETWORK_BINARIES =
  /\b(curl|wget|fetch|nc|ncat|netcat|ssh|scp|sftp|ftp|telnet|nmap|openssl|socat|aria2c|httpie|xh)\b/i;

/** Destructive / privilege / install-global patterns. */
const BLOCKED_SUBSTRINGS = [
  "sudo ",
  "sudo\t",
  "doas ",
  "mkfs",
  ":(){",
  "shutdown",
  "reboot",
  "poweroff",
  "halt ",
  "npm install -g",
  "npm i -g",
  "pnpm add -g",
  "yarn global",
  "pip install --user",
  "pip3 install --user",
] as const;

/**
 * Return a human reason if the command must not run; otherwise null.
 */
export function assertSafeShellCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return "Empty command";
  if (trimmed.length > MAX_COMMAND_CHARS) {
    return `Command too long (max ${MAX_COMMAND_CHARS} chars)`;
  }
  if (/[\n\r\0]/.test(trimmed)) {
    return "Blocked multiline or null-byte shell command";
  }

  // Pipes and substitution enable exfil / remote code (curl | sh, $(...), `...`).
  if (trimmed.includes("|")) {
    return "Blocked shell pipe (|)";
  }
  if (trimmed.includes("`") || /\$\(/.test(trimmed)) {
    return "Blocked shell command substitution (` or $())";
  }

  // Process substitution / here-strings that often wrap network tools.
  if (/<\(/.test(trimmed) || />\(/.test(trimmed)) {
    return "Blocked process substitution";
  }

  // Redirects to absolute paths or home (stay in workspace cwd otherwise).
  if (/(^|[;&\s])>{1,2}\s*(\/|~)/.test(trimmed)) {
    return "Blocked redirect to absolute or home path";
  }

  // Leave the workspace via cd.
  if (/(^|[;&])\s*cd\s+(\/|~|\.\.(?:\/|$))/.test(trimmed) || /^\s*cd\s+(\/|~|\.\.)/.test(trimmed)) {
    return "Blocked cd outside workspace";
  }

  if (NETWORK_BINARIES.test(trimmed)) {
    return "Blocked network / remote binary";
  }

  const lower = trimmed.toLowerCase();
  for (const pattern of BLOCKED_SUBSTRINGS) {
    if (lower.includes(pattern)) {
      return `Blocked shell pattern: ${pattern.trim()}`;
    }
  }

  // Recursive delete is too easy to aim at ~ or .. even with cwd set.
  if (
    /\brm\b/.test(lower) &&
    /(?:^|\s)-[a-z]*r[a-z]*f\b|(?:^|\s)-[a-z]*f[a-z]*r\b|(?:^|\s)--recursive\b/.test(lower)
  ) {
    return "Blocked recursive rm";
  }

  // rm of absolute / home path even without -rf.
  if (/\brm\b/.test(lower) && /(?:^|[\s;])(?:\/|~)/.test(trimmed)) {
    return "Blocked rm of absolute or home path";
  }

  // dd / disk wipe
  if (/\bdd\b/.test(lower) && /\bif\s*=/.test(lower)) {
    return "Blocked dd if=";
  }

  // Interpreter one-liners often used to fetch/run payloads.
  if (/\b(python3?|perl|ruby|node|osascript|php)\b/.test(lower) && /\s-[ce]\b/.test(lower)) {
    return "Blocked interpreter -c/-e one-liner";
  }

  // chmod/chown on absolute or home paths
  if (/\b(chmod|chown)\b/.test(lower) && /(?:^|[\s;])(?:\/|~)/.test(trimmed)) {
    return "Blocked chmod/chown on absolute or home path";
  }

  return null;
}
