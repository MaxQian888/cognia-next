/**
 * Output sink — the single seam the CLI writes through, so command handlers
 * stay testable (tests pass a capturing sink instead of the real streams).
 */
export interface OutputSink {
  /** Write to stdout (no implicit newline). */
  write: (text: string) => void
  /** Write a line to stderr. */
  error: (text: string) => void
  /** Write one JSON object as a line to stdout (JSONL mode). */
  json: (obj: unknown) => void
}

export const realOutput: OutputSink = {
  write: (text) => process.stdout.write(text),
  error: (text) => process.stderr.write(text.endsWith("\n") ? text : text + "\n"),
  json: (obj) => process.stdout.write(JSON.stringify(obj) + "\n"),
}
