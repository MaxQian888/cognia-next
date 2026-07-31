/**
 * Control-character sanitizer for attacker-influenced PR text (CI log tails,
 * review comment bodies) before it is pasted into an agent's prompt. A TS port
 * of agent-orchestrator's `domain.SanitizeControlChars`: anyone who can comment
 * on a PR or make CI print bytes can embed terminal escape sequences, so strip
 * them so they cannot drive the agent's pane / injection surface.
 *
 * Tabs, newlines, and carriage returns are preserved so log formatting survives;
 * every other C0 control char, DEL, the C1 range, and any ANSI/CSI escape
 * sequence is removed. The dedup signature is always computed on the RAW bytes
 * upstream, so sanitizing here never affects change detection.
 *
 * Implemented with a char-code predicate + a RegExp built from \\u escapes so
 * the source file contains no raw control bytes.
 */

// All regexes are built from \u escapes so the source file contains no raw
// control bytes. Order matters: OSC (arbitrary text incl. spaces, up to a BEL or
// ST terminator) is stripped before the CSI/Fe passes.

// OSC: `ESC ]` (0x1B 0x5D) or single-byte 0x9D, any content, terminated by BEL
// (0x07), ST (`ESC \`), or end-of-string. Non-greedy so it stops at the first
// terminator.
const OSC = new RegExp("(?:\\u001B\\]|\\u009D)[\\s\\S]*?(?:\\u0007|\\u001B\\\\|$)", "g")

// CSI: `ESC [` (0x1B 0x5B) or single-byte 0x9B, parameter/intermediate bytes,
// final byte 0x40-0x7E.
const CSI = new RegExp("(?:\\u001B\\[|\\u009B)[0-9;:<=>?]*[ -/]*[@-~]", "g")

// Fe two-byte escape sequences (`ESC` + 0x40-0x5F), e.g. `ESC c` reset. OSC/CSI
// are already stripped, so this cannot eat their introducers.
const FE = new RegExp("\\u001B[@-Z\\\\-_]", "g")

/** Keep TAB (0x09), LF (0x0A), CR (0x0D); drop other C0, DEL (0x7F), C1 (0x80-0x9F). */
function isStrippableControl(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
}

/** Strip ANSI/OSC/CSI escape sequences and disallowed control characters. */
export function sanitizeControlChars(input: string): string {
  if (!input) return input
  const noEscapes = input.replace(OSC, "").replace(CSI, "").replace(FE, "")
  let out = ""
  for (const ch of noEscapes) {
    const code = ch.codePointAt(0) ?? 0
    if (!isStrippableControl(code)) out += ch
  }
  return out
}
