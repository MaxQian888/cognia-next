// The lead's plan parser, kept a leaf so the structured-dispatch path (and the
// team pattern nodes built on it) can use it without importing the team
// runtime, which would close an import cycle through the workflow engine.

/** Strict JSON-fenced-block parser preserved from the legacy runtime. */
export function parseProposedPlan(
  text: string
): { ok: true; plan: unknown } | { ok: false; reason: string } {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, reason: "empty plan text" }
  }
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i)
  const candidate = fenceMatch ? fenceMatch[1] : text.trim()
  try {
    const parsed: unknown = JSON.parse(candidate ?? "")
    return { ok: true, plan: parsed }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
