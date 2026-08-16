// Sidecar view of the Code-mode tool allowlist (ADR-0117, Phase 4).
//
// Reads the same `lib/settings/builtin-tools-data.json` the renderer's
// `lib/ai/code-mode/eligibility.ts` reads, so there is exactly one allowlist.
// A second hand-maintained list here would be the classic drift bug where the
// UI shows one surface and the executor accepts another — and the executor is
// the side that matters.
//
// Eligibility is an explicit `programmaticReadOnly: true` declaration. It is
// deliberately NOT derived from `requiresApproval === false` (TodoWrite and
// TaskCreate carry that flag and mutate state) and never from the MCP
// `readOnlyHint` annotation, which third-party servers declare about
// themselves.

import metadata from "../../../lib/settings/builtin-tools-data.json" with { type: "json" }

/** @returns {ReadonlyArray<string>} bare names of every eligible tool */
export function programmaticReadOnlyToolNames() {
  return Object.freeze(
    metadata.categories.flatMap((category) =>
      category.tools.filter((t) => t.programmaticReadOnly === true).map((t) => t.name)
    )
  )
}

const ELIGIBLE = new Set(programmaticReadOnlyToolNames())

/**
 * Every tool the metadata knows about, eligible or not — used to tell
 * "you may not call that" apart from "that does not exist".
 */
const KNOWN = new Set(metadata.categories.flatMap((c) => c.tools.map((t) => t.name)))

/** @param {string} name */
export function isProgrammaticReadOnly(name) {
  return ELIGIBLE.has(typeof name === "string" ? name.trim() : name)
}

/**
 * The choke point every sandbox tool request passes through.
 *
 * @param {string} name
 * @returns {{ allowed: true } | { allowed: false, reason: "unknown-tool" | "not-programmatic-read-only" }}
 */
export function checkToolEligibility(name) {
  const trimmed = typeof name === "string" ? name.trim() : ""
  if (ELIGIBLE.has(trimmed)) return { allowed: true }
  return {
    allowed: false,
    reason: KNOWN.has(trimmed) ? "not-programmatic-read-only" : "unknown-tool",
  }
}
