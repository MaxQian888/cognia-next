// Shared per-tool execution deadline for READ-ONLY built-in tools.
//
// Read-only file tools (`content_search`, `file_search`, `glob`, `grep`,
// `read`, the git read tools, `lsp_*`, …) walk the workspace with NO internal
// deadline, so a huge / cyclic tree makes their handler hang effectively
// forever. While a tool is "in flight" the run-and-capture idle watchdog stays
// PAUSED, so without a per-tool net the whole turn only died at the wall-clock
// (the "session … did not end within 300000ms" users hit). Now that the
// interactive TUI turn disables that wall-clock, this net is the real backstop
// against a hung read-only tool — and it must cover BOTH dispatch channels:
//   • ai-sdk path — `dispatch/ai-sdk-tools.mjs` bounds the handler at execute
//     time and surfaces a thrown `tool-error`;
//   • Anthropic path — `builtin-tools/index.mjs` wraps the def handler at
//     registration time and surfaces an `isError` CallToolResult.
// Both react the same way: the model gets a recoverable error and the orphaned
// read-only handler (no side effects to unwind) is left to settle and be GC'd.
// Exec tools (bash / shell / process / git-run) self-bound with their own
// timeout, so they are NEVER bounded here — only `READ_ONLY_TOOL_NAMES`.

/**
 * Default per-tool execution budget in ms. Single source of truth shared by
 * both dispatch channels so they never drift. `0` / non-finite disables the net.
 */
export const DEFAULT_BUILTIN_TOOL_TIMEOUT_MS = 120_000

/**
 * The recoverable error text shown to the model when a read-only tool blows its
 * budget. Kept here so both channels emit byte-identical wording.
 * @param {string} name  bare tool name
 * @param {number} ms    the budget that was exceeded
 */
export function toolBudgetMessage(name, ms) {
  return (
    `tool "${name}" exceeded its ${ms}ms execution budget and was abandoned — ` +
    "the target is likely too large to scan; narrow the directory/pattern or raise " +
    "`toolExecutionTimeoutMs`."
  )
}

/** Sentinel resolved by the deadline leg of the race (never a real tool value). */
const TIMEOUT = Symbol("read-only-tool-timeout")

/**
 * Wrap ONE tool def's handler with the read-only execution deadline, returning a
 * NEW def (the original is never mutated). Tools not in `readOnly`, and any tool
 * when `timeoutMs` is `0` / non-finite, are returned untouched.
 *
 * On timeout the wrapped handler RESOLVES with an `isError` CallToolResult — the
 * shape the Anthropic-path MCP server expects. The ai-sdk path's
 * `builtinDefToAiSdkTool` already converts an `isError` result into a thrown
 * `execute` (→ AI SDK `tool-error`), so both channels stay consistent. A handler
 * that resolves or rejects BEFORE the deadline passes through unchanged.
 *
 * @param {{ name: string, handler: Function }} def
 * @param {number} timeoutMs
 * @param {ReadonlySet<string>} readOnly
 */
export function wrapHandlerWithReadOnlyTimeout(def, timeoutMs, readOnly) {
  if (!def || typeof def.handler !== "function") return def
  if (!readOnly || !readOnly.has(def.name)) return def
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return def

  const handler = def.handler
  const wrapped = (args, extra) => {
    // Normalise sync/throwing handlers into a promise so the race is uniform.
    const work = Promise.resolve().then(() => handler(args, extra))
    let timer = null
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs)
      if (timer && typeof timer.unref === "function") timer.unref()
    })
    return Promise.race([work, deadline]).then(
      (winner) => {
        if (timer) clearTimeout(timer)
        if (winner === TIMEOUT) {
          // Detach the orphaned handler's eventual settle so a late
          // resolve/reject can't surface as an unhandled rejection.
          void work.then(
            () => {},
            () => {}
          )
          return {
            content: [{ type: "text", text: toolBudgetMessage(def.name, timeoutMs) }],
            isError: true,
          }
        }
        return winner
      },
      (err) => {
        // Handler rejected before the deadline — pass its error through.
        if (timer) clearTimeout(timer)
        throw err
      }
    )
  }
  return { ...def, handler: wrapped }
}

/**
 * Map a list of tool defs through {@link wrapHandlerWithReadOnlyTimeout}. Returns
 * the same array reference when the net is disabled (`0` / non-finite) so the
 * common "no budget" path allocates nothing.
 *
 * @param {Array<{ name: string, handler: Function }>} defs
 * @param {number} timeoutMs
 * @param {ReadonlySet<string>} readOnly
 */
export function wrapDefsWithReadOnlyTimeout(defs, timeoutMs, readOnly) {
  if (!Array.isArray(defs)) return defs
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return defs
  return defs.map((def) => wrapHandlerWithReadOnlyTimeout(def, timeoutMs, readOnly))
}
