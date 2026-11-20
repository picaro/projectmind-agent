import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PayloadRejected } from "./validate.ts";

/** Directory the agent owns. Paths from the command payload are never used. */
export function defaultEnvFileRoot(): string {
  return path.join(os.tmpdir(), "imemory-personal-node-env");
}

const SAFE_COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const PLAIN_VALUE = /^[\w./:@%$+-]*$/;

export function assertEnvFilePath(file: string, root: string): string {
  if (!file || file.includes("\0") || file.includes("..")) {
    throw new PayloadRejected(
      "forbidden_command_field",
      "Environment file path is not under the agent temp directory.",
    );
  }
  if (!path.isAbsolute(file) || !path.isAbsolute(root)) {
    throw new PayloadRejected(
      "forbidden_command_field",
      "Environment file path must be an absolute path under the agent temp directory.",
    );
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(file);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PayloadRejected(
      "forbidden_command_field",
      "Environment file path is not under the agent temp directory.",
    );
  }
  return resolved;
}

/** Planned path for one command. The payload cannot choose this path. */
export function runtimeEnvFilePath(root: string, commandId: string): string {
  if (!SAFE_COMMAND_ID.test(commandId) || commandId.includes("..")) {
    throw new PayloadRejected(
      "invalid_input",
      "Command id cannot be used as an environment file name.",
    );
  }
  return assertEnvFilePath(path.join(path.resolve(root), `${commandId}.env`), root);
}

function quoteEnvValue(value: string): string {
  if (PLAIN_VALUE.test(value)) return value;
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")}"`;
}

/** Docker env-file text. Values are not placed on argv. */
export function formatEnvFile(env: Record<string, string>): string {
  const lines: string[] = [];
  for (const key of Object.keys(env).sort()) {
    if (!ENV_KEY.test(key)) {
      throw new PayloadRejected("invalid_input", "Environment key is not a valid name.");
    }
    const value = env[key];
    if (typeof value !== "string" || value.includes("\0")) {
      throw new PayloadRejected("invalid_input", "Environment value is not usable.");
    }
    lines.push(`${key}=${quoteEnvValue(value)}`);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** Inverse of formatEnvFile, used by tests to compare a redeemed map. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq);
    let value = line.slice(eq + 1);
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    out[key] = value;
  }
  return out;
}

/**
 * Writes the redeemed map as mode 0600. The directory is mode 0700.
 * Caller deletes the file in a finally block.
 */
export async function writeRuntimeEnvFile(input: {
  root: string;
  commandId: string;
  env: Record<string, string>;
}): Promise<string> {
  const root = path.resolve(input.root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const file = runtimeEnvFilePath(root, input.commandId);
  await writeFile(file, formatEnvFile(input.env), { mode: 0o600, flag: "w" });
  await chmod(file, 0o600);
  return file;
}

export async function removeRuntimeEnvFile(file: string, root: string): Promise<void> {
  let resolved: string;
  try {
    resolved = assertEnvFilePath(file, root);
  } catch {
    return;
  }
  try {
    await rm(resolved, { force: true });
  } catch (error) {
    // No env file exists when a preparation root is missing or is not a directory.
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}
