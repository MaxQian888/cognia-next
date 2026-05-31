// PostToolUse diagnostics hook (OpenCode's highest-ROI pattern).
//
// After the agent edits a file, run the language server over it and
// append any errors/warnings to the turn as additional context so the
// model self-corrects without an extra orchestration round-trip. Wired
// into the `query()` options' `hooks.PostToolUse` in `anthropic.mjs`.
//
// The resolver is injected (per-session); when it is null the hook is a
// no-op, so non-coding sessions and the LSP-host-unavailable case pay
// nothing.

import path from "node:path"
import { formatDiagnostics } from "../lsp/report.mjs"

/** Edit-like tools whose output should be followed by a diagnostics pass. */
export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])

/** Extract the edited file path from a tool input payload. */
export function extractEditedPath(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null
  if (toolName === "NotebookEdit") {
    return toolInput.notebook_path ?? toolInput.file_path ?? null
  }
  return toolInput.file_path ?? toolInput.path ?? null
}

/**
 * Build a PostToolUse hook callback that appends LSP diagnostics.
 *
 * @param {{ getDiagnostics: (file: string, opts?: object) => Promise<Array> } | null} resolver
 * @param {{ minSeverity?: number }} [opts]
 * @returns {(input: any) => Promise<object>}
 */
export function makePostToolUseDiagnostics(resolver, opts = {}) {
  const minSeverity = opts.minSeverity ?? 2 // errors + warnings
  return async (input) => {
    if (!resolver) return {}
    try {
      const toolName = input?.tool_name
      if (!EDIT_TOOLS.has(toolName)) return {}
      const filePath = extractEditedPath(toolName, input?.tool_input)
      if (!filePath) return {}
      const diags = await resolver.getDiagnostics(filePath)
      const block = formatDiagnostics(filePath, diags, { minSeverity })
      if (!block) return {}
      return {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: `LSP errors detected in ${path.basename(filePath)} — please fix:\n${block}`,
        },
      }
    } catch {
      // Diagnostics are best-effort; never fail the tool result.
      return {}
    }
  }
}

/**
 * Build the SDK `hooks` fragment for diagnostics-after-edit. Returns
 * `undefined` when no resolver is available so the caller can omit the
 * field entirely.
 *
 * @param {object|null} resolver
 * @param {object} [opts]
 * @returns {{ PostToolUse: Array<{ hooks: Function[] }> } | undefined}
 */
export function buildLspHooks(resolver, opts = {}) {
  if (!resolver) return undefined
  return { PostToolUse: [{ hooks: [makePostToolUseDiagnostics(resolver, opts)] }] }
}
