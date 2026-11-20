import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { PayloadRejected } from "./validate.ts";

const reject = (message: string): never => {
  throw new PayloadRejected("invalid_input", message);
};

async function regular(context: string, file: string, limit = 262144): Promise<string> {
  try {
    const info = await lstat(path.join(context, file));
    if (!info.isFile() || info.size === 0 || info.size > limit) throw new Error();
    const contents = await readFile(path.join(context, file), "utf8");
    if (Buffer.byteLength(contents) > limit || contents.includes("\0")) throw new Error();
    return contents;
  } catch {
    return reject(
      `Generated builds require a nonempty regular ${file} within the input size limit. Commit it or use an explicit Dockerfile.`,
    );
  }
}

/** Validation only: never evaluate manifests or create/update dependency locks on the host. */
export async function frozenLanguageInputs(
  context: string,
  files: readonly string[],
): Promise<{ bundlerVersion?: string }> {
  if (files.includes("go.mod")) {
    for (const file of ["go.mod", ...(files.includes("go.work") ? ["go.work"] : [])]) {
      const contents = await regular(context, file);
      if (/^\s*toolchain\s/m.test(contents)) {
        reject(
          "Generated Go builds use the pinned base SDK. Use an explicit Dockerfile for a custom toolchain declaration.",
        );
      }
    }
    for (const file of ["go.sum", "go.work.sum"].filter((file) => files.includes(file))) {
      await regular(context, file, 16777216);
    }
  } else if (files.includes("composer.json")) {
    const manifest = await regular(context, "composer.json");
    const lock = await regular(context, "composer.lock", 16777216);
    try {
      const parsed: unknown = JSON.parse(manifest),
        locked: unknown = JSON.parse(lock);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        !locked ||
        typeof locked !== "object" ||
        !Array.isArray((locked as { packages?: unknown }).packages)
      )
        throw new Error();
    } catch {
      reject(
        "Generated PHP builds require valid composer.json and composer.lock files. Commit the Composer lock or use an explicit Dockerfile.",
      );
    }
  } else if (files.includes("Gemfile")) {
    await regular(context, "Gemfile");
    const lock = await regular(context, "Gemfile.lock", 16777216);
    const versions = [
      ...lock.matchAll(/^BUNDLED WITH\r?\n[ \t]+([0-9]+\.[0-9]+\.[0-9]+)[ \t]*(?:\r?\n|$)/gm),
    ];
    if (versions.length !== 1)
      reject(
        "Commit Gemfile.lock with one exact BUNDLED WITH version, or use an explicit Dockerfile.",
      );
    return { bundlerVersion: versions[0]![1]! };
  } else if (files.includes("Cargo.toml")) {
    await regular(context, "Cargo.toml");
    await regular(context, "Cargo.lock", 16777216);
    const toolchains = ["rust-toolchain", "rust-toolchain.toml"].filter((file) =>
      files.includes(file),
    );
    if (toolchains.length > 1)
      reject("Keep one exact Rust toolchain declaration or use an explicit Dockerfile.");
    for (const file of toolchains) {
      const contents = await regular(context, file);
      const channels = file.endsWith(".toml")
        ? [...contents.matchAll(/^\s*channel\s*=\s*["']([^"']+)["']\s*(?:#[^\r\n]*)?$/gm)]
        : [];
      const channel =
        file.endsWith(".toml") && /^\s*\[toolchain\]\s*$/m.test(contents) && channels.length === 1
          ? channels[0]![1]!
          : file === "rust-toolchain"
            ? contents.trim()
            : "";
      if (!/^(?:[0-9]+\.[0-9]+\.[0-9]+|nightly-[0-9]{4}-[0-9]{2}-[0-9]{2})$/.test(channel)) {
        reject(
          "Generated Rust builds require an exact or dated nightly toolchain; floating channels need an explicit Dockerfile.",
        );
      }
    }
  }
  return {};
}
