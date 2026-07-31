import { useCallback, useRef } from "react"
import type { Dispatch } from "react"
import type { TuiAction } from "../../state/types"
import { formatBashResult } from "../../commands/bash-shellout"
import type { ShellResult, RunShellOpts } from "../../../agent/run-shell"
import { detectInteractiveCommand } from "@/lib/claude/permissions/interactive-command"

type RunShell = (command: string, opts: RunShellOpts) => Promise<ShellResult>

/** A captured foreground `!command` failure, fed to `/analyze`. */
export interface BashFailure {
  command: string
  output: string
  exitCode?: number
}

/** A live `!command` run, as surfaced by `/bashes`. */
export interface BashRunInfo {
  id: string
  command: string
  startedAt: number
  background: boolean
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
  /** Kill ANY live run — foreground or backgrounded — by cell id (`/bashes kill`).
   * Returns false when the id doesn't match a live run. */
  killBash: (id: string) => boolean
  /** Bring a backgrounded run back to the foreground (`/bashes fg`): it becomes
   * the Ctrl+C / Ctrl+B target again and any current foreground run is
   * backgrounded. Returns false when the id doesn't match a live run. */
  foregroundBash: (id: string) => boolean
  /** Snapshot every live run (foreground + background), oldest first. */
  listBashRuns: () => BashRunInfo[]
  /** Whether a foreground `!command` is currently running. */
  hasForegroundRun: () => boolean
  /** Feed a line into the foreground `!command`'s stdin (append newline) — for
   * line-based prompts like `y/n` or a passphrase. Returns false when there is
   * no foreground run, or it hasn't exposed a stdin writer yet. */
  sendInputToForeground: (line: string) => boolean
  /** Take (and clear) the most recent foreground command that exited non-zero,
   * so `/analyze` can send it to the agent exactly once. */
  takeLastFailedBash: () => BashFailure | null
}

interface LiveRun {
  command: string
  controller: AbortController
  startedAt: number
  background: boolean
  /** Writer into the child's stdin, set once the process has spawned. */
  writeInput?: (data: string) => void
}

/**
 * The `!command` shell-out cluster: live bash cells, foreground/background
 * lifecycle, Ctrl+C kill, and the last-failure capture that powers `/analyze`.
 * Only one command runs in the foreground at a time (a new one backgrounds any
 * prior one) so Ctrl+C / Ctrl+B always target the latest. EVERY live run —
 * including backgrounded ones — keeps its AbortController in the registry, so
 * `/bashes` can list, kill, or re-foreground it at any time (nothing leaks
 * until process exit any more).
 */
export function useBashShellout(
  runShell: RunShell,
  cwd: string,
  dispatch: Dispatch<TuiAction>
): BashShellout {
  // Registry of every live run keyed by cell id. Entries are added by `runBash`
  // and removed when the process settles (result or spawn error) — so the map
  // always mirrors "what is actually running" and `/bashes` reads it directly.
  const runsRef = useRef(new Map<string, LiveRun>())
  // The cell id of the run Ctrl+C / Ctrl+B target, or null when none.
  const foregroundIdRef = useRef<string | null>(null)
  // Monotonic id source for bash cells (distinct namespace from the reducer's
  // `c<seq>` ids, so a streamed result always lands on the right cell).
  const bashSeqRef = useRef(0)
  // The most recent FOREGROUND `!command` that exited non-zero — `/analyze`
  // sends it to the agent. Cleared once analysed or superseded.
  const lastFailedBashRef = useRef<BashFailure | null>(null)

  const backgroundForegroundBash = useCallback(() => {
    const id = foregroundIdRef.current
    const run = id ? runsRef.current.get(id) : undefined
    if (!id || !run) return false
    run.background = true
    foregroundIdRef.current = null
    dispatch({ type: "BASH_BACKGROUND", id })
    dispatch({ type: "NOTICE", message: "Command moved to background · /bashes to manage" })
    return true
  }, [dispatch])

  const killForegroundBash = useCallback(() => {
    const id = foregroundIdRef.current
    const run = id ? runsRef.current.get(id) : undefined
    if (!id || !run) return false
    foregroundIdRef.current = null
    run.controller.abort()
    dispatch({ type: "NOTICE", message: "Command interrupted" })
    return true
  }, [dispatch])

  const killBash = useCallback(
    (id: string) => {
      const run = runsRef.current.get(id)
      if (!run) return false
      if (foregroundIdRef.current === id) foregroundIdRef.current = null
      run.controller.abort()
      dispatch({ type: "NOTICE", message: `Killed: ${run.command}` })
      return true
    },
    [dispatch]
  )

  const foregroundBash = useCallback(
    (id: string) => {
      const run = runsRef.current.get(id)
      if (!run) return false
      // Demote any current foreground run first — single-foreground invariant.
      const prevId = foregroundIdRef.current
      if (prevId && prevId !== id) {
        const prev = runsRef.current.get(prevId)
        if (prev) {
          prev.background = true
          dispatch({ type: "BASH_BACKGROUND", id: prevId })
        }
      }
      run.background = false
      foregroundIdRef.current = id
      dispatch({ type: "BASH_FOREGROUND", id })
      dispatch({ type: "NOTICE", message: `Foreground: ${run.command} · Ctrl+C kills it` })
      return true
    },
    [dispatch]
  )

  const listBashRuns = useCallback(
    () =>
      Array.from(runsRef.current, ([id, run]) => ({
        id,
        command: run.command,
        startedAt: run.startedAt,
        background: run.background,
      })),
    []
  )

  const runBash = useCallback(
    (command: string) => {
      // Only one foreground run at a time: send any prior one to the background
      // so this command owns Ctrl+C without killing the old one.
      backgroundForegroundBash()
      const id = `bash-${++bashSeqRef.current}`
      const controller = new AbortController()
      runsRef.current.set(id, { command, controller, startedAt: Date.now(), background: false })
      foregroundIdRef.current = id
      dispatch({ type: "BASH_START", command, id })
      // A `!command` has no TTY here; if it needs one, tell the user they can
      // still drive line-based prompts (y/n, passphrase) via the composer.
      if (detectInteractiveCommand(command).interactive) {
        dispatch({
          type: "NOTICE",
          message: "Interactive command — type input + Enter to send it; Ctrl+C to kill",
        })
      }
      void Promise.resolve(
        runShell(command, {
          cwd,
          signal: controller.signal,
          // Stream output live into the cell; the final BASH_RESULT reflows it to
          // the clean formatted form (trim + exit note) once the process exits.
          onChunk: (chunk) => dispatch({ type: "BASH_APPEND", chunk, id }),
          // Hand back a stdin writer so a submitted composer line can reach this
          // run while it holds the foreground.
          registerInput: (write) => {
            const run = runsRef.current.get(id)
            if (run) run.writeInput = write
          },
        })
      )
        .then((r) => {
          const wasForeground = foregroundIdRef.current === id
          if (wasForeground) foregroundIdRef.current = null
          runsRef.current.delete(id)
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
          if (foregroundIdRef.current === id) foregroundIdRef.current = null
          runsRef.current.delete(id)
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

  const hasForegroundRun = useCallback(() => foregroundIdRef.current !== null, [])
  const sendInputToForeground = useCallback((line: string) => {
    const id = foregroundIdRef.current
    const run = id ? runsRef.current.get(id) : undefined
    if (!id || !run || !run.writeInput) return false
    run.writeInput(line.endsWith("\n") ? line : `${line}\n`)
    return true
  }, [])
  const takeLastFailedBash = useCallback(() => {
    const failure = lastFailedBashRef.current
    lastFailedBashRef.current = null
    return failure
  }, [])

  return {
    runBash,
    backgroundForegroundBash,
    killForegroundBash,
    killBash,
    foregroundBash,
    listBashRuns,
    hasForegroundRun,
    sendInputToForeground,
    takeLastFailedBash,
  }
}
