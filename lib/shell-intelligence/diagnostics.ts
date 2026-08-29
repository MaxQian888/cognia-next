/**
 * Advisory validation for a `!` shell line.
 *
 * The rule that shapes everything here: a diagnostic is a *hint*, never a gate.
 * The user's shell is the authority on what runs, and an underline that blocked
 * Enter would make this feature worse than the plain textarea it replaces — the
 * one command the checker is wrong about would become unrunnable.
 *
 * The hard part is not detection, it is TIMING. `k` on the way to `kubectl` is
 * not an error, and underlining it while the user is mid-word is the behaviour
 * that makes editors' squiggles feel hostile. So an unknown command is only
 * reported once the user is demonstrably done typing it — either the line
 * committed it (whitespace, an operator, or Enter), or they stopped typing long
 * enough that the word is their finished answer.
 */

import { isPathLikeToken, type LexToken } from "./lex"
import { segmentCommandLine, findUnterminatedQuote } from "./segments"
import { shellUsesBackslashEscapes } from "@/lib/terminal/completion/tokenize"
import {
  DIAGNOSTIC_MIN_LENGTH,
  type ResolvedShell,
  type ShellAvailability,
  type ShellDiagnostic,
} from "./types"

/**
 * What is known about a command name.
 *
 * `"pending"` is load-bearing: an answer that has not arrived is NOT "unknown",
 * and treating it as one would underline every command for as long as the host
 * lookup takes.
 */
export type CommandVerdict = "known" | "unknown" | "pending"

/**
 * Diagnostic text, supplied by the calling component.
 *
 * The shell-shaped messages take the shell as an argument rather than being
 * built around one: the component would otherwise need the resolved shell to
 * build the messages, and the resolver needs the messages — a cycle bought for
 * nothing, since the text is a one-line interpolation either way.
 */
export interface DiagnosticMessages {
  commandNotFound(name: string): string
  incompleteSyntax(): string
  /** The Host does not have this shell. */
  shellUnavailable(shell: string): string
  /** Nobody here knows how to hand a command line to this shell family. */
  unsupportedShell(shell: string): string
}

export interface DiagnosticsInput {
  line: string
  shell: ResolvedShell
  availability: ShellAvailability
  /**
   * True once the user has pressed Enter. Commits every command on the line,
   * including a trailing word nothing else has committed.
   */
  submitted: boolean
  /** True once the input has been idle for {@link DIAGNOSTIC_IDLE_MS}. */
  idle: boolean
  /**
   * Why execution is refused, when it is. Only distinguishes the two
   * `shell-unavailable` cases — "the Host hasn't got it" and "we can't drive
   * it" are different problems with different fixes.
   */
  reason?: "shell-missing" | "unsupported-family" | "no-host"
  /** What is known about each command name. */
  lookup: (name: string) => CommandVerdict
  messages: DiagnosticMessages
}

/**
 * A name a shell resolves by means this layer cannot see — a variable, a glob,
 * or a substitution — is never called unknown. The check is deliberately
 * conservative: anything with shell metacharacters left in it is skipped.
 */
function isOpaqueName(token: LexToken): boolean {
  return /[$*?\[\]{}!~]/.test(token.raw) || token.raw !== token.value
}

/**
 * Has the user finished typing this command name?
 *
 * Committed by anything that proves the word ended: another token after it in
 * the same command, a separator or redirect following it, trailing whitespace,
 * or Enter. Short of all that, only the idle timer can commit it.
 */
function isCommitted(line: string, head: LexToken, hasLaterToken: boolean, submitted: boolean) {
  if (submitted || hasLaterToken) return true
  const next = line[head.end]
  // End of line with nothing after it: still being typed.
  if (next === undefined) return false
  return /\s/.test(next) || /[|&;<>()`]/.test(next)
}

/**
 * Compute the advisory diagnostics for a line.
 *
 * Ordered most-structural first: a line with an unterminated quote is not
 * really parsed yet, so its command names are not reported as unknown on top of
 * that — one honest problem beats three derived ones.
 */
export function computeDiagnostics(input: DiagnosticsInput): ShellDiagnostic[] {
  const { line, messages } = input
  const diagnostics: ShellDiagnostic[] = []

  if (input.availability === "shell-unavailable") {
    diagnostics.push({
      from: 0,
      to: line.length,
      severity: "error",
      code: "shell-unavailable",
      message:
        input.reason === "unsupported-family"
          ? messages.unsupportedShell(input.shell.path)
          : messages.shellUnavailable(input.shell.path),
    })
  }

  const escapes = shellUsesBackslashEscapes(input.shell.kind)
  const unterminated = findUnterminatedQuote(line, { backslashEscapes: escapes })
  if (unterminated) {
    // Only reported once the user has stopped typing or submitted — an opening
    // quote is unterminated for as long as it takes to type the closing one.
    if (input.idle || input.submitted) {
      diagnostics.push({
        from: unterminated.from,
        to: unterminated.to,
        severity: "warning",
        code: "incomplete-syntax",
        message: messages.incompleteSyntax(),
      })
    }
    return diagnostics
  }

  for (const segment of segmentCommandLine(line, { backslashEscapes: escapes })) {
    const head = segment.head
    if (!head || head.value.length === 0) continue
    if (isPathLikeToken(head.value) || isOpaqueName(head)) continue

    const headIndex = segment.tokens.indexOf(head)
    const hasLaterToken = segment.tokens.length > headIndex + 1
    const committed = isCommitted(line, head, hasLaterToken, input.submitted)
    if (!committed) {
      // Uncommitted: judged only after the user stops typing, and never on a
      // single character — `l` is the start of far too many commands.
      if (!input.idle || head.value.length < DIAGNOSTIC_MIN_LENGTH) continue
    }

    if (input.lookup(head.value) !== "unknown") continue
    diagnostics.push({
      from: head.start,
      to: head.end,
      severity: "warning",
      code: "command-not-found",
      message: messages.commandNotFound(head.value),
    })
  }

  return diagnostics
}

/**
 * Whether a name is a command this client knows about without asking a Host —
 * a shell builtin or a CLI the in-repo specs describe.
 *
 * Used both to answer `"known"` offline and to suppress the host probe for
 * names that need no probing.
 */
export function isStaticallyKnownCommand(
  name: string,
  builtins: readonly string[],
  specNames: readonly string[]
): boolean {
  const lower = name.toLowerCase()
  return (
    builtins.some((b) => b.toLowerCase() === lower) ||
    specNames.some((s) => s.toLowerCase() === lower)
  )
}

/** Every command name on the line worth resolving — deduped, in order. */
export function commandNamesInLine(line: string, shell: ResolvedShell): string[] {
  const escapes = shellUsesBackslashEscapes(shell.kind)
  const seen = new Set<string>()
  const names: string[] = []
  for (const segment of segmentCommandLine(line, { backslashEscapes: escapes })) {
    const head = segment.head
    if (!head || head.value.length === 0) continue
    // No `isEnvAssignment` check: `findHead` already skipped assignments when
    // it chose the head, and a second copy of that rule is how the two drift.
    if (isPathLikeToken(head.value) || isOpaqueName(head)) continue
    if (seen.has(head.value)) continue
    seen.add(head.value)
    names.push(head.value)
  }
  return names
}
