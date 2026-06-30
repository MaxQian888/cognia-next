/**
 * Command output extraction for the integrated terminal.
 *
 * OSC 633 (`osc633.rs`) carries no command output frame — it only marks the
 * command boundaries (A/B/C/D). To surface a finished command's *output* (for
 * the command-menu "Copy output" action and the quick-fix evaluator), we read
 * the xterm buffer rows between the command's start marker and its end marker,
 * mirroring VS Code's `CommandDetectionCapability.getOutput`.
 *
 * The pure bits live here — buffer-row reads happen through a
 * {@link BufferLineReader} so the logic is unit-testable without an xterm
 * instance. The same indirection the `fileLinkProvider` uses in
 * `terminal-instance.tsx` (`buffer.active.getLine(n).translateToString(true)`).
 */

/**
 * Reads the trimmed text of an absolute buffer line, or `null` when the line
 * is out of range / not yet rendered. In the renderer this wraps
 * `term.buffer.active.getLine(line)?.translateToString(true)`.
 */
export type BufferLineReader = (line: number) => string | null

/**
 * Collect buffer-line text in `[startLine, endLineExclusive)`. Out-of-range or
 * unreadable lines (reader returns `null`) are skipped, not pushed as blanks,
 * so a trimmed scrollback never injects phantom empty rows. Returns `[]` for a
 * non-finite or inverted range.
 */
export function readBufferRange(
  read: BufferLineReader,
  startLine: number,
  endLineExclusive: number
): string[] {
  if (!Number.isFinite(startLine) || !Number.isFinite(endLineExclusive)) return []
  const from = Math.max(0, Math.floor(startLine))
  const to = Math.floor(endLineExclusive)
  const out: string[] = []
  for (let line = from; line < to; line++) {
    const text = read(line)
    if (text == null) continue
    out.push(text)
  }
  return out
}

/**
 * Join captured output rows into a single string, trimming trailing blank
 * rows (xterm pads the viewport with empty cells, and the prompt that follows
 * a command shouldn't bleed into its captured output). Leading/interior blank
 * lines are preserved — they're real output.
 */
export function joinOutput(lines: readonly string[]): string {
  let end = lines.length
  while (end > 0 && lines[end - 1].trim().length === 0) end--
  return lines.slice(0, end).join("\n")
}

/**
 * Resolve the exclusive output end line for a command, given its own start
 * line and the start lines of all commands. Output runs until the next
 * command's start marker; when this is the most recent command, it runs to
 * `fallbackEnd` (the live cursor's absolute row). Pure so the bounding rule is
 * tested independently of marker disposal races.
 */
export function outputEndLine(
  startLine: number,
  allStartLines: readonly number[],
  fallbackEnd: number
): number {
  let next: number | null = null
  for (const line of allStartLines) {
    if (line > startLine && (next === null || line < next)) next = line
  }
  return next ?? fallbackEnd
}
