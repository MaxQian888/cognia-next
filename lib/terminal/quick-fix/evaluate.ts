/**
 * Quick-fix evaluator — runs the built-in matchers against a finished command
 * and returns the proposed actions. Pure: the renderer supplies the captured
 * command line, output rows, and exit code; the surfaced actions are dispatched
 * by `terminal-quick-fix.tsx`.
 *
 * Mirrors VS Code's `TerminalQuickFixAddon._resolveQuickFixes` flow:
 * command-line gate → exit-status gate → output window + line match →
 * `getActions`, with de-duplication by action id across all matchers.
 */

import {
  BUILTIN_QUICK_FIX_MATCHERS,
  firstWindowMatch,
  windowOutput,
  type QuickFixAction,
  type QuickFixMatcher,
} from "./matchers"

export interface QuickFixContext {
  /** The command line that was run (authoritative keystroke capture). */
  commandLine: string
  /** Captured output rows (trailing blanks already trimmed). */
  outputLines: string[]
  /** Exit code from OSC 633 `D`; `null` (unknown) never matches. */
  exitCode: number | null
}

/** True when `exitCode` satisfies the matcher's required result. */
function exitMatches(
  exitCode: number | null,
  result: QuickFixMatcher["commandExitResult"]
): boolean {
  if (exitCode === null) return false
  return result === "success" ? exitCode === 0 : exitCode !== 0
}

/**
 * Evaluate all matchers and return de-duplicated quick-fix actions. A blank
 * command line short-circuits to `[]`.
 */
export function evaluateQuickFixes(
  ctx: QuickFixContext,
  matchers: readonly QuickFixMatcher[] = BUILTIN_QUICK_FIX_MATCHERS
): QuickFixAction[] {
  if (!ctx.commandLine || ctx.commandLine.trim().length === 0) return []

  const actions: QuickFixAction[] = []
  const seen = new Set<string>()

  for (const matcher of matchers) {
    if (!matcher.commandLineMatcher.test(ctx.commandLine)) continue
    if (!exitMatches(ctx.exitCode, matcher.commandExitResult)) continue

    let windowLines: string[] = []
    let outputMatch: RegExpMatchArray | null = null
    if (matcher.outputMatcher) {
      windowLines = windowOutput(ctx.outputLines, matcher.outputMatcher)
      const found = firstWindowMatch(windowLines, matcher.outputMatcher.lineMatcher)
      if (!found) continue
      outputMatch = found.match
    }

    let produced: QuickFixAction[]
    try {
      produced = matcher.getActions({
        commandLine: ctx.commandLine,
        outputLines: ctx.outputLines,
        windowLines,
        outputMatch,
      })
    } catch {
      // A malformed matcher must never break the terminal event loop.
      continue
    }

    for (const action of produced) {
      if (seen.has(action.id)) continue
      seen.add(action.id)
      actions.push(action)
    }
  }

  return actions
}
