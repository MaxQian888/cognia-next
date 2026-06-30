import { useCallback, useRef } from "react"
import type { Dispatch } from "react"
import type { TuiAction } from "../../state/types"
import { formatBashResult } from "../../commands/bash-shellout"
import type { ShellResult, RunShellOpts } from "../../../agent/run-shell"

type RunShell = (command: string, opts: RunShellOpts) => Promise<ShellResult>

/** A captured foreground `!command` failure, fed to `/analyze`. */
export interface BashFailure {
  command: string
  output: string
  exitCode?: number
}

export interface BashShellout {
  /** Run a `!command` shell-out: append a live bash cell, then fill it with the
   * result. Any prior foreground run is moved to the background first. */
  runBash: (command: string) => void
  /** Move the foreground `!command` to the background — it keeps running but is
   * no longer the Ctrl+C target. Returns false when nothing is in the foreground. */
  backgroundForegroundBash: () => boolean
  /** Kill the foreground `!command` and its whole process tree (Ctrl+C on a
   * blocking command). Returns false when nothing is in the foreground. */
  killForegroundBash: () => boolean
  /** Whether a foreground `!command` is currently running. */
  hasForegroundRun: () => boolean
  /** Take (and clear) the most recent foreground command that exited non-zero,
   * so `/analyze` can send it to the agent exactly once. */
  takeLastFailedBash: () => BashFailure | null
}

/**
 * The `!command` shell-out cluster: live bash cells, foreground/background
 * lifecycle, Ctrl+C kill, and the last-failure capture that powers `/analyze`.
 * Only one command runs in the foreground at a time (a new one backgrounds any
 * prior one) so Ctrl+C / Ctrl+B always target the latest.
 */
export function useBashShellout(
  runShell: RunShell,
  cwd: string,
  dispatch: Dispatch<TuiAction>
): BashShellout {
  // The foreground `!command`: Ctrl+C kills it, Ctrl+B backgrounds it. The
  // controller's signal is wired into `runShell` so an abort tears down the
  // whole process tree.
  const bashRunRef = useRef<{ id: string; controller: AbortController } | null>(null)
  // Monotonic id source for bash cells (distinct namespace from the reducer's
  // `c<seq>` ids, so a streamed result always lands on the right cell).
  const bashSeqRef = useRef(0)
  // The most recent FOREGROUND `!command` that exited non-zero — `/analyze`
  // sends it to the agent. Cleared once analysed or superseded.
  const lastFailedBashRef = useRef<BashFailure | null>(null)

  const backgroundForegroundBash = useCallback(() => {
    const run = bashRunRef.current
    if (!run) return false
    bashRunRef.current = null
    dispatch({ type: "BASH_BACKGROUND", id: run.id })
    dispatch({ type: "NOTICE", message: "Command moved to background" })
    return true
  }, [dispatch])

  const killForegroundBash = useCallback(() => {
    const run = bashRunRef.current
    if (!run) return false
    bashRunRef.current = null
    run.controller.abort()
    dispatch({ type: "NOTICE", message: "Command interrupted" })
    return true
  }, [dispatch])

  const runBash = useCallback(
    (command: string) => {
      // Only one foreground run at a time: send any prior one to the background
      // so this command owns Ctrl+C without killing the old one.
      backgroundForegroundBash()
      const id = `bash-${++bashSeqRef.current}`
      const controller = new AbortController()
      bashRunRef.current = { id, controller }
      dispatch({ type: "BASH_START", command, id })
      void Promise.resolve(
        runShell(command, {
          cwd,
          signal: controller.signal,
          // Stream output live into the cell; the final BASH_RESULT reflows it to
          // the clean formatted form (trim + exit note) once the process exits.
          onChunk: (chunk) => dispatch({ type: "BASH_APPEND", chunk, id }),
        })
      )
        .then((r) => {
          const wasForeground = bashRunRef.current?.id === id
          if (wasForeground) bashRunRef.current = null
          dispatch({
            type: "BASH_RESULT",
            output: formatBashResult(r),
            status: r.code === 0 ? "done" : "error",
            exitCode: r.code,
            id,
          })
          // Offer AI diagnosis only for a foreground command that genuinely
          // failed — a user-initiated Ctrl+C (aborted) isn't a failure to debug.
          if (wasForeground && !r.aborted && r.code !== 0) {
            lastFailedBashRef.current = {
              command,
              output: formatBashResult(r),
              exitCode: r.code,
            }
            dispatch({
              type: "NOTICE",
              message: `Command failed (exit ${r.code}) · /analyze to debug with AI`,
            })
          }
        })
        .catch((err: unknown) => {
          if (bashRunRef.current?.id === id) bashRunRef.current = null
          dispatch({
            type: "BASH_RESULT",
            output: err instanceof Error ? err.message : String(err),
            status: "error",
            id,
          })
        })
    },
    [runShell, cwd, dispatch, backgroundForegroundBash]
  )

  const hasForegroundRun = useCallback(() => bashRunRef.current !== null, [])
  const takeLastFailedBash = useCallback(() => {
    const failure = lastFailedBashRef.current
    lastFailedBashRef.current = null
    return failure
  }, [])

  return {
    runBash,
    backgroundForegroundBash,
    killForegroundBash,
    hasForegroundRun,
    takeLastFailedBash,
  }
}
