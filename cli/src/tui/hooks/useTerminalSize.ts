/**
 * Reactive terminal dimensions. Reads `columns`/`rows` from the Ink-managed
 * stdout and re-renders the subscriber whenever the terminal is resized, so the
 * layout (full-width composer, windowed lists) reflows to the new size instead
 * of smearing the old one.
 *
 * Only the App subscribes; it threads `columns` (→ width) and a derived row
 * budget (→ list windowing) down as props so the leaf components stay pure.
 */
import { useEffect, useState } from "react"
import { useStdout } from "ink"

export interface TerminalSize {
  columns: number
  rows: number
}

/** Fallbacks for a non-TTY stdout (pipes, CI) where columns/rows are undefined. */
export const DEFAULT_COLUMNS = 80
export const DEFAULT_ROWS = 24

/** A stdout we can read size from and listen to for resizes. */
export interface ResizableStdout {
  columns?: number
  rows?: number
  on?: (event: "resize", listener: () => void) => void
  off?: (event: "resize", listener: () => void) => void
}

/** Read the current size, falling back to a sane 80×24 for a non-TTY stream. */
export function readSize(stdout: ResizableStdout | undefined): TerminalSize {
  const columns = stdout?.columns && stdout.columns > 0 ? stdout.columns : DEFAULT_COLUMNS
  const rows = stdout?.rows && stdout.rows > 0 ? stdout.rows : DEFAULT_ROWS
  return { columns, rows }
}

/**
 * Track the terminal size, updating on every `resize` event. The `override` is a
 * test seam — production reads the real Ink stdout.
 */
export function useTerminalSize(override?: ResizableStdout): TerminalSize {
  const ink = useStdout()
  const stdout = override ?? (ink.stdout as ResizableStdout | undefined)
  const [size, setSize] = useState<TerminalSize>(() => readSize(stdout))

  useEffect(() => {
    if (!stdout?.on) return
    const onResize = () => setSize(readSize(stdout))
    // Re-read on (re)subscribe in case the size changed between the initial
    // render and the effect firing.
    onResize()
    stdout.on("resize", onResize)
    return () => {
      stdout.off?.("resize", onResize)
    }
  }, [stdout])

  return size
}
