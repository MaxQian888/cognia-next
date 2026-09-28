import type { LspDiagnostic } from "../services/lsp/report.ts"
import type { HookInput, HookOutput } from "./kernel/types.ts"
export interface Diagnostic extends LspDiagnostic {
  code?: string | number
  ruleId?: string
}
export interface DiagnosticsResolver {
  getDiagnostics(file: string): Promise<unknown[]>
}
export interface DiagnosticsOptions {
  minSeverity?: number
  ledger?: ReturnType<typeof createDiagnosticsLedger>
}

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
import { formatDiagnostics } from "../services/lsp/report.ts"

/** Edit-like tools whose output should be followed by a diagnostics pass. */
export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])

/** Extract the edited file path from a tool input payload. */
export function extractEditedPath(toolName: string, value: unknown): string | null {
  const toolInput = value as Record<string, string> | null
  if (!toolInput || typeof toolInput !== "object") return null
  if (toolName === "NotebookEdit") {
    return toolInput.notebook_path ?? toolInput.file_path ?? null
  }
  return toolInput.file_path ?? toolInput.path ?? null
}

/**
 * Position-independent identity for a diagnostic. Keyed on severity + code +
 * message, NOT line/column — so a warning that merely shifts down when the edit
 * inserts lines above it is recognized as the SAME diagnostic (not a new one).
 * Two identical messages on different lines collapse; acceptable for a "did this
 * edit introduce a NEW problem" signal (omp's diagnostics-ledger tradeoff).
 */
export function diagnosticIdentity(d: Diagnostic | null | undefined) {
  const sev = d?.severity ?? ""
  const code = d?.code ?? d?.ruleId ?? ""
  const msg = String(d?.message ?? "").trim()
  return `${sev}|${code}|${msg}`
}

/**
 * Per-session diagnostics ledger — remembers the diagnostics already surfaced
 * for each file so a PostToolUse pass reports only what is NEW since the last
 * pass to that file, instead of re-dumping every pre-existing warning the model
 * didn't cause on every edit. Mirrors omp's `diagnostics-ledger`.
 */
export function createDiagnosticsLedger() {
  /** @type {Map<string, Set<string>>} */
  const seen = new Map<string, Set<string>>()
  return {
    /**
     * Return only the diagnostics not seen since the last pass for `file`, and
     * advance the ledger to the current full set (so a problem the model fixes
     * this turn can be reported again if it reappears later).
     */
    reduceToNew(file: string, diags: readonly Diagnostic[]): Diagnostic[] {
      const prev = seen.get(file)
      const currentIds = new Set<string>()
      const fresh: Diagnostic[] = []
      for (const d of diags) {
        const id = diagnosticIdentity(d)
        currentIds.add(id)
        if (!prev || !prev.has(id)) fresh.push(d)
      }
      seen.set(file, currentIds)
      return fresh
    },
    /** Seed a file's baseline (e.g. at read time) without reporting anything. */
    seed(file: string, diags: readonly Diagnostic[]) {
      const ids = new Set<string>()
      for (const d of diags) ids.add(diagnosticIdentity(d))
      seen.set(file, ids)
    },
    reset() {
      seen.clear()
    },
  }
}

/**
 * Build a PostToolUse hook callback that appends LSP diagnostics.
 *
 * @param {{ getDiagnostics: (file: string, opts?: object) => Promise<Array> } | null} resolver
 * @param {{ minSeverity?: number, ledger?: ReturnType<typeof createDiagnosticsLedger> }} [opts]
 * @returns {(input: any) => Promise<object>}
 */
export function makePostToolUseDiagnostics(
  resolver: DiagnosticsResolver | null,
  opts: DiagnosticsOptions = {}
) {
  const minSeverity = opts.minSeverity ?? 2 // errors + warnings
  const ledger = opts.ledger ?? null
  return async (input: HookInput): Promise<HookOutput> => {
    if (!resolver) return {}
    try {
      const toolName = input?.tool_name
      if (!toolName || !EDIT_TOOLS.has(toolName)) return {}
      const filePath = extractEditedPath(toolName, input?.tool_input)
      if (!filePath) return {}
      const allDiags = (await resolver.getDiagnostics(filePath)) as Diagnostic[]
      // With a ledger, surface only diagnostics new since the last pass to this
      // file — the model sees what its own edit introduced, not the file's whole
      // pre-existing warning backlog. Without one, report the full set (legacy).
      const diags = ledger ? ledger.reduceToNew(filePath, allDiags) : allDiags
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
export function buildLspHooks(resolver: DiagnosticsResolver | null, opts: DiagnosticsOptions = {}) {
  if (!resolver) return undefined
  // One ledger per session (per buildLspHooks call) so repeated edits to the
  // same file only surface newly-introduced diagnostics. Overridable for tests.
  const ledger = opts.ledger ?? createDiagnosticsLedger()
  return { PostToolUse: [{ hooks: [makePostToolUseDiagnostics(resolver, { ...opts, ledger })] }] }
}
