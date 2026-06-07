// Doom-loop guard (opencode-inspired): when the SAME tool is called with the
// SAME input `threshold` times in a session, force the approval round-trip
// even if a ruleset/suppress-list would have allowed it silently. Catches
// runaway agent loops (e.g. a model re-running an identical failing grep
// forever) without hard-terminating the session — the user decides.
//
// Shared by both dispatch paths: `createToolPermissionGate` (ai-sdk) and
// `canUseTool` (anthropic).

export const DEFAULT_DOOM_THRESHOLD = 3

/**
 * JSON.stringify with sorted object keys at every level so two semantically
 * identical inputs always produce the same signature.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`
}

/**
 * @param {{ threshold?: number }} [opts]
 * @returns {{ check: (toolName: string, input: unknown) => "ask" | null, reset: () => void }}
 */
export function createDoomLoopGuard({ threshold = DEFAULT_DOOM_THRESHOLD } = {}) {
  /** @type {Map<string, number>} */
  const counts = new Map()

  return {
    /**
     * Record one call and return "ask" when this exact call has now been
     * made `threshold`-or-more times.
     */
    check(toolName, input) {
      let sig
      try {
        sig = `${toolName}:${stableStringify(input ?? {})}`
      } catch {
        return null // unserializable input — don't guess
      }
      const n = (counts.get(sig) ?? 0) + 1
      counts.set(sig, n)
      return n >= threshold ? "ask" : null
    },

    reset() {
      counts.clear()
    },
  }
}
