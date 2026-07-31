// Sentinel-framed command protocol over the PTY stream.
//
// We cannot read Strix's report files with ctx.fs (a builtin plugin can't
// discover its absolute sandbox path), so every command is framed with unique
// markers printed to stdout, and we recover completion + exit code + captured
// output by scanning the accumulated terminal buffer. All builders/parsers here
// are pure and unit-tested; the orchestration that writes + polls lives in
// `pty.ts`.
//
// Markers (token = a per-command random id):
//   run:      <cmd>; printf '\n@@SXD:<token>:%s@@\n' "$?"
//   capture:  printf '@@SXC:<token>@@'; { <cmd>; } 2>&1; printf '@@SXE:<token>:%s@@\n' "$?"
//
// A digit-terminated end marker (`:<code>@@`) never matches the echoed command
// template (`:%s@@`), so echo can't produce a false completion.

/** Build a "run + report exit code" command (output streams normally). */
export function buildRunCommand(command: string, token: string): string {
  return `${command}; printf '\\n@@SXD:${token}:%s@@\\n' "$?"`
}

/** Build a "capture stdout+stderr between markers + exit code" command. */
export function buildCaptureCommand(command: string, token: string): string {
  return `printf '@@SXC:${token}@@'; { ${command}; } 2>&1; printf '@@SXE:${token}:%s@@\\n' "$?"`
}

/** Find the completion marker for a run command; null until it appears. */
export function findDone(buffer: string, token: string): { exitCode: number } | null {
  const m = new RegExp(`@@SXD:${escapeToken(token)}:(-?\\d+)@@`).exec(buffer)
  return m ? { exitCode: Number.parseInt(m[1], 10) } : null
}

/** Extract a capture command's raw output + exit code; null until complete. */
export function extractCapture(
  buffer: string,
  token: string
): { raw: string; exitCode: number } | null {
  const begin = `@@SXC:${token}@@`
  const end = new RegExp(`@@SXE:${escapeToken(token)}:(-?\\d+)@@`).exec(buffer)
  if (!end) return null
  // Use the LAST begin marker before the end marker so a shell echo of the
  // command (begin without a digit-end) can't pollute the captured region.
  const beginIdx = buffer.lastIndexOf(begin, end.index)
  if (beginIdx < 0) return null
  return {
    raw: buffer.slice(beginIdx + begin.length, end.index),
    exitCode: Number.parseInt(end[1], 10),
  }
}

/** Remove any of our sentinels from a text chunk (keep the console clean). */
export function stripMarkers(text: string): string {
  return text.replace(/@@SX[DCE]:[^@]*@@\n?/g, "")
}

/** Decode base64 (whitespace-tolerant, so `base64` line-wrapping is fine) to a UTF-8 string. */
export function decodeBase64Utf8(b64: string): string {
  const clean = b64.replace(/\s+/g, "")
  if (!clean) return ""
  const bin = atob(clean)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function escapeToken(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
