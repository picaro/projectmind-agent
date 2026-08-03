/**
 * Parse plan/questions payloads from Cursor SDK (and other) plan-phase output.
 * Kept in mac-agent so the runner does not depend on the web app package path.
 */

export type PlanInteraction =
  | { type: "plan"; summary: string; steps: string[] }
  | {
      type: "questions";
      questions: Array<{ id: string; prompt: string; options?: string[] }>;
    };

function parseInteraction(raw: unknown): PlanInteraction | null {
  if (raw == null) return null;
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;

  if (obj.type === "plan") {
    const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
    const steps = Array.isArray(obj.steps)
      ? obj.steps
          .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          .map((s) => s.trim())
      : [];
    if (!summary && steps.length === 0) return null;
    return { type: "plan", summary: summary || steps.join("; "), steps };
  }

  if (obj.type === "questions") {
    const questions = Array.isArray(obj.questions)
      ? obj.questions
          .map((q, i) => {
            if (!q || typeof q !== "object" || Array.isArray(q)) return null;
            const row = q as Record<string, unknown>;
            const prompt =
              typeof row.prompt === "string"
                ? row.prompt.trim()
                : typeof row.text === "string"
                  ? row.text.trim()
                  : "";
            if (!prompt) return null;
            const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : `q${i + 1}`;
            const options = Array.isArray(row.options)
              ? row.options
                  .filter((o): o is string => typeof o === "string" && o.trim().length > 0)
                  .map((o) => o.trim())
              : undefined;
            return { id, prompt, ...(options?.length ? { options } : {}) };
          })
          .filter((q): q is NonNullable<typeof q> => q != null)
      : [];
    if (questions.length === 0) return null;
    return { type: "questions", questions };
  }

  return null;
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw.trim()) as unknown;
  } catch {
    return null;
  }
}

export function extractInteractionFromText(text: string): PlanInteraction | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    const parsed = parseInteraction(tryParseJson(fence[1]));
    if (parsed) return parsed;
  }

  const direct = parseInteraction(tryParseJson(trimmed));
  if (direct) return direct;

  const brace = trimmed.match(/\{[\s\S]*\}/);
  if (brace?.[0]) {
    const parsed = parseInteraction(tryParseJson(brace[0]));
    if (parsed) return parsed;
  }

  if (trimmed.length >= 40) {
    return {
      type: "plan",
      summary: trimmed.slice(0, 4000),
      steps: [trimmed.slice(0, 2000)],
    };
  }

  return null;
}
