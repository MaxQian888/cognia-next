/**
 * Process-level crash guards for the TUI. A React error boundary only catches
 * throws during render/lifecycle — an error in an async callback or an unhandled
 * promise rejection escapes it entirely. Left to Node's defaults, an
 * `uncaughtException` prints a stack to stderr (smearing the Ink frame) and then
 * exits the process, and an `unhandledRejection` prints a warning.
 *
 * Installing handlers here does two things: it appends a structured crash record
 * (so the fault is durable), and — because a registered `uncaughtException`
 * listener overrides Node's default termination — it keeps the TUI alive instead
 * of dying mid-session. Best-effort resilience: the goal is to survive a stray
 * rejection, not to mask a truly fatal fault forever.
 *
 * The `ProcessLike` seam makes the wiring unit-testable without touching the real
 * `process` global.
 */
import type { CrashLogger } from "./crash-log"

type UncaughtHandler = (err: Error) => void
type RejectionHandler = (reason: unknown) => void

/** The slice of `process` we register on — injectable for tests. */
export interface ProcessLike {
  on(event: "uncaughtException", cb: UncaughtHandler): unknown
  on(event: "unhandledRejection", cb: RejectionHandler): unknown
  off(event: "uncaughtException", cb: UncaughtHandler): unknown
  off(event: "unhandledRejection", cb: RejectionHandler): unknown
}

/**
 * Register `uncaughtException` + `unhandledRejection` handlers that log via
 * `log`. Returns an uninstall function that removes exactly the handlers it
 * added (so the caller can clean up on exit and tests don't leak listeners).
 */
export function installProcessCrashGuards(
  log: CrashLogger,
  proc: ProcessLike = process
): () => void {
  const onUncaught: UncaughtHandler = (err) => log("uncaughtException", err)
  const onRejection: RejectionHandler = (reason) => log("unhandledRejection", reason)
  proc.on("uncaughtException", onUncaught)
  proc.on("unhandledRejection", onRejection)
  return () => {
    proc.off("uncaughtException", onUncaught)
    proc.off("unhandledRejection", onRejection)
  }
}
