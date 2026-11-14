/**
 * Model ids the control plane and older agent settings still send, but that
 * Cursor CLI / Antigravity no longer treat as current.
 *
 * Grok 4.5 and 4.6 → Grok 4.7 (same effort).
 * Opus 4.5 (and the Opus 4.6 thinking id Antigravity used as a stand-in) →
 * Opus 5.5 High, which is in both the Cursor CLI and `agy` catalogs.
 */
export function canonicalDeprecatedModel(model: string): string {
  const trimmed = model.trim();
  const key = trimmed.toLowerCase();

  const grok = key.match(/^(?:cursor-)?grok-4\.[1-6]-(low|medium|high|xhigh)(-fast)?$/);
  if (grok) return `grok-4.7-${grok[1]}${grok[2] ?? ""}`;

  if (key === "claude-4.5-opus-high-thinking" || key === "claude-4.5-opus-thinking") {
    return "claude-opus-5-thinking-high";
  }

  if (
    key === "claude-opus-4-5" ||
    key === "claude-opus-4.5" ||
    key === "claude-4.5-opus" ||
    key === "claude-4.5-opus-high" ||
    key === "claude-4-opus" ||
    key === "claude-opus-4-6" ||
    key === "claude-opus-4-6-thinking"
  ) {
    return "claude-opus-5-5-high";
  }

  return trimmed;
}

/** Rewrite a `runner/model` usage key when the model id is deprecated. */
export function canonicalLlmUsageKey(key: string): string {
  const slash = key.indexOf("/");
  if (slash <= 0) return key;
  const runner = key.slice(0, slash);
  const model = key.slice(slash + 1);
  if (!model || model === "default") return key;
  return `${runner}/${canonicalDeprecatedModel(model)}`;
}
