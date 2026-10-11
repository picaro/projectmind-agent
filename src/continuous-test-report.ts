/**
 * Playwright JSON report handling for continuous test runs: read (even after a
 * non-zero exit), strip attachment bodies and stdio, cap at the contract's
 * 2 MB, pick bounded failure artifacts, and scrub secrets from any text that
 * leaves this machine.
 */
import fs from "node:fs";
import path from "node:path";
import {
  CONTINUOUS_TEST_MAX_ERROR_SUMMARY_CHARS,
  CONTINUOUS_TEST_MAX_REPORT_BYTES,
  type ContinuousTestArtifactKind,
} from "./improvement-contracts/continuous-test-job.js";
import { redactSecrets } from "./redact.js";

const REDACTED = "***";

const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

/** `password=…`, `"api_key": "…"`, `TOKEN: …` — keep the name, drop the value. */
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|session)[A-Za-z0-9_-]*)(["']?\s*[:=]\s*["']?)([^\s"'&,;]{4,})/gi;

/** Values of this agent's own secret-looking env vars (API keys, tokens). */
export function secretEnvValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([key, value]) => value && /KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|COOKIE/i.test(key))
    .map(([, value]) => value as string);
}

export function scrubSecrets(text: string, secrets: Array<string | null | undefined> = []): string {
  if (!text) return text;
  let out = redactSecrets(text, secrets);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(SECRET_ASSIGNMENT, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`);
  return out;
}

/** Short, single-line, scrubbed reason for `errorSummary`. */
export function summarizeError(text: string, secrets: Array<string | null | undefined> = []): string {
  const clean = scrubSecrets(text, secrets)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > CONTINUOUS_TEST_MAX_ERROR_SUMMARY_CHARS
    ? `${clean.slice(0, CONTINUOUS_TEST_MAX_ERROR_SUMMARY_CHARS - 1)}…`
    : clean;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Parse the JSON reporter output. Accepts leading noise on stdout before the object. */
export function parseReportText(text: string | null | undefined): JsonRecord | null {
  if (!text?.trim()) return null;
  const tryParse = (raw: string): JsonRecord | null => {
    try {
      const parsed = asRecord(JSON.parse(raw));
      return parsed && Array.isArray(parsed.suites) ? parsed : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(text);
  if (direct) return direct;
  const start = text.indexOf("{\n");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? tryParse(text.slice(start, end + 1)) : null;
}

/** Report file first (PLAYWRIGHT_JSON_OUTPUT_*), then stdout. */
export function readPlaywrightReport(reportPath: string, stdout: string): JsonRecord | null {
  try {
    if (fs.existsSync(reportPath)) {
      const fromFile = parseReportText(fs.readFileSync(reportPath, "utf8"));
      if (fromFile) return fromFile;
    }
  } catch {
    // Unreadable file — fall back to stdout.
  }
  return parseReportText(stdout);
}

export type FailureAttachment = {
  kind: Exclude<ContinuousTestArtifactKind, "report">;
  name: string;
  mime: string;
  path: string;
  testTitle: string;
};

type Visit = (test: JsonRecord, result: JsonRecord, title: string) => void;

function walkResults(report: JsonRecord, visit: Visit): void {
  const walk = (suite: JsonRecord, titles: string[]) => {
    const here = typeof suite.title === "string" && suite.title ? [...titles, suite.title] : titles;
    for (const specRaw of asArray(suite.specs)) {
      const spec = asRecord(specRaw);
      if (!spec) continue;
      const title = [...here, typeof spec.title === "string" ? spec.title : "(untitled)"].join(" › ");
      for (const testRaw of asArray(spec.tests)) {
        const test = asRecord(testRaw);
        if (!test) continue;
        for (const resultRaw of asArray(test.results)) {
          const result = asRecord(resultRaw);
          if (result) visit(test, result, title);
        }
      }
    }
    for (const child of asArray(suite.suites)) {
      const rec = asRecord(child);
      if (rec) walk(rec, here);
    }
  };
  for (const suite of asArray(report.suites)) {
    const rec = asRecord(suite);
    if (rec) walk(rec, []);
  }
}

export function reportHasFailures(report: JsonRecord | null): boolean {
  if (!report) return false;
  let failed = false;
  walkResults(report, (test) => {
    if (test.status === "unexpected" || test.status === "flaky") failed = true;
  });
  return failed;
}

const KIND_BY_MIME: Record<string, FailureAttachment["kind"]> = {
  "image/png": "screenshot",
  "image/jpeg": "screenshot",
  "application/zip": "trace",
  "video/webm": "video",
  "video/mp4": "video",
};

/** Names that may hold cookies/session state — never uploaded. */
const SENSITIVE_ATTACHMENT = /storage-?state|\.env\b|\.har$|cookie|auth|credential|secret/i;

const KIND_PRIORITY: Record<FailureAttachment["kind"], number> = { screenshot: 0, trace: 1, video: 2 };

function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Failure evidence from failed/timed-out results, restricted to files inside
 * the run workspace (a report can name any path) and ordered screenshots →
 * traces → videos so the most useful evidence fits within `maxFiles`.
 */
export function selectFailureAttachments(
  report: JsonRecord,
  workspaceRoot: string,
  limits: { maxFiles: number; maxBytesPerFile: number },
): FailureAttachment[] {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(workspaceRoot);
  } catch {
    return [];
  }
  const picked: FailureAttachment[] = [];
  const seen = new Set<string>();
  walkResults(report, (_test, result, title) => {
    if (result.status === "passed" || result.status === "skipped") return;
    for (const raw of asArray(result.attachments)) {
      const att = asRecord(raw);
      const mime = typeof att?.contentType === "string" ? att.contentType : "";
      const filePath = typeof att?.path === "string" ? att.path : "";
      const kind = KIND_BY_MIME[mime];
      if (!kind || !filePath) continue;
      const name = path.basename(filePath);
      if (SENSITIVE_ATTACHMENT.test(name) || SENSITIVE_ATTACHMENT.test(String(att?.name ?? ""))) continue;
      let real: string;
      try {
        real = fs.realpathSync(path.resolve(realRoot, filePath));
        const stat = fs.statSync(real);
        if (!stat.isFile() || stat.size === 0 || stat.size > limits.maxBytesPerFile) continue;
      } catch {
        continue;
      }
      if (!isPathInside(realRoot, real) || seen.has(real)) continue;
      seen.add(real);
      picked.push({ kind, name, mime, path: real, testTitle: title.slice(0, 300) });
    }
  });
  return picked
    .sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind])
    .slice(0, Math.max(0, limits.maxFiles));
}

function truncate(value: unknown, max: number): unknown {
  return typeof value === "string" && value.length > max ? `${value.slice(0, max)}…` : value;
}

function sanitizeError(err: unknown, secrets: string[], maxChars: number): unknown {
  const rec = asRecord(err);
  if (!rec) return typeof err === "string" ? truncate(scrubSecrets(err, secrets), maxChars) : err;
  const out: JsonRecord = {};
  for (const key of ["message", "stack", "value"]) {
    if (typeof rec[key] === "string") out[key] = truncate(scrubSecrets(rec[key] as string, secrets), maxChars);
  }
  if (rec.location) out.location = rec.location;
  return out;
}

type Level = { errorChars: number; keepResultDetail: boolean };

const LEVELS: Level[] = [
  { errorChars: 8_000, keepResultDetail: true },
  { errorChars: 1_000, keepResultDetail: true },
  { errorChars: 300, keepResultDetail: false },
];

/**
 * Copy of the report without attachment bodies, stdout/stderr, or absolute
 * paths; error text scrubbed. Keeps every field the server's verdict parser
 * reads (suites/specs/tests status, expectedStatus, projectName, results status, errors).
 */
function sanitizeReport(report: JsonRecord, secrets: string[], level: Level): JsonRecord {
  const sanitizeResult = (result: JsonRecord): JsonRecord => {
    if (!level.keepResultDetail) {
      return { status: result.status, retry: result.retry, duration: result.duration };
    }
    const out: JsonRecord = { ...result };
    delete out.stdout;
    delete out.stderr;
    delete out.steps;
    out.attachments = asArray(result.attachments).map((raw) => {
      const att = asRecord(raw) ?? {};
      return {
        name: att.name,
        contentType: att.contentType,
        ...(typeof att.path === "string" ? { path: path.basename(att.path) } : {}),
      };
    });
    if (result.error) out.error = sanitizeError(result.error, secrets, level.errorChars);
    out.errors = asArray(result.errors).map((e) => sanitizeError(e, secrets, level.errorChars));
    return out;
  };
  const sanitizeSuite = (suite: JsonRecord): JsonRecord => ({
    ...suite,
    specs: asArray(suite.specs).map((specRaw) => {
      const spec = asRecord(specRaw) ?? {};
      return {
        ...spec,
        tests: asArray(spec.tests).map((testRaw) => {
          const test = asRecord(testRaw) ?? {};
          return { ...test, results: asArray(test.results).map((r) => sanitizeResult(asRecord(r) ?? {})) };
        }),
      };
    }),
    suites: asArray(suite.suites).map((s) => sanitizeSuite(asRecord(s) ?? {})),
  });
  const out: JsonRecord = {
    ...report,
    suites: asArray(report.suites).map((s) => sanitizeSuite(asRecord(s) ?? {})),
    errors: asArray(report.errors).map((e) => sanitizeError(e, secrets, level.errorChars)),
  };
  // `config` carries absolute paths and the full reporter/env setup; the verdict never needs it.
  delete out.config;
  return out;
}

export type PreparedReport =
  | { ok: true; report: JsonRecord; bytes: number; level: number }
  | { ok: false; reason: string };

/** Sanitize and fit under the contract's report limit, trimming detail progressively. */
export function prepareReportForUpload(
  report: JsonRecord,
  secrets: string[] = [],
  maxBytes: number = CONTINUOUS_TEST_MAX_REPORT_BYTES,
): PreparedReport {
  let lastBytes = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    const candidate = sanitizeReport(report, secrets, LEVELS[i]!);
    lastBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    if (lastBytes <= maxBytes) return { ok: true, report: candidate, bytes: lastBytes, level: i };
  }
  return {
    ok: false,
    reason: `Playwright report is ${lastBytes} bytes after trimming (limit ${maxBytes})`,
  };
}
