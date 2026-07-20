import { useSyncExternalStore } from "react"

export type ComputerUsePipPhase = "idle" | "running" | "complete" | "error"

export interface ComputerUsePipResult {
  ok: boolean
  output?: string
  error?: string
  display_width_px?: number
  display_height_px?: number
}

export interface ComputerUsePipSnapshot {
  action: string | null
  phase: ComputerUsePipPhase
  error: string | null
  hidden: boolean
  /** Fully dismissed for the current run (no pill); re-shows on the next run. */
  dismissed: boolean
  /**
   * Whole-turn terminal flag, distinct from the per-action `phase`. Set when the
   * owning chat session leaves the running state so the UI can show a "done"
   * terminal and auto-collapse; reset to `false` the moment a fresh run begins.
   */
  ended: boolean
  frame: { src: string; width: number; height: number; capturedAt: number } | null
}

const EMPTY_SNAPSHOT: ComputerUsePipSnapshot = {
  action: null,
  phase: "idle",
  error: null,
  hidden: false,
  dismissed: false,
  ended: false,
  frame: null,
}

const snapshots = new Map<string, ComputerUsePipSnapshot>()
const listeners = new Set<() => void>()
let alwaysHidden = false

function emitChange(): void {
  for (const listener of listeners) listener()
}

export function getComputerUsePipSnapshot(sessionId: string): ComputerUsePipSnapshot {
  return snapshots.get(sessionId) ?? EMPTY_SNAPSHOT
}

export function subscribeComputerUsePip(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publishComputerUseActivity(
  sessionId: string | undefined,
  action: string,
  result?: ComputerUsePipResult
): void {
  if (!sessionId) return
  const current = getComputerUsePipSnapshot(sessionId)
  const running = result == null
  // A running action published after the previous turn ended marks the start of
  // a fresh run: re-expand a manually/auto-collapsed surface. Within a live run
  // a manual hide must persist, so `hidden` is only reset at this boundary.
  const startingNewRun = running && current.ended
  const nextFrame =
    action === "screenshot" &&
    result?.ok &&
    result.output &&
    result.display_width_px != null &&
    result.display_height_px != null
      ? {
          src: `data:image/png;base64,${result.output}`,
          width: result.display_width_px,
          height: result.display_height_px,
          capturedAt: Date.now(),
        }
      : current.frame

  snapshots.set(sessionId, {
    ...current,
    action,
    phase: running ? "running" : result.ok ? "complete" : "error",
    error: result?.ok === false ? (result.error ?? null) : null,
    hidden: startingNewRun ? false : current.hidden,
    dismissed: startingNewRun ? false : current.dismissed,
    ended: false,
    frame: nextFrame,
  })
  emitChange()
}

export function setComputerUsePipHidden(sessionId: string, hidden: boolean): void {
  snapshots.set(sessionId, { ...getComputerUsePipSnapshot(sessionId), hidden })
  emitChange()
}

/** Fully dismiss the surface for the current run (no pill until the next run). */
export function setComputerUsePipDismissed(sessionId: string, dismissed: boolean): void {
  snapshots.set(sessionId, { ...getComputerUsePipSnapshot(sessionId), dismissed })
  emitChange()
}

/** Mark the session's turn as finished so the UI can show a terminal state. */
export function setComputerUsePipRunEnded(sessionId: string, ended = true): void {
  snapshots.set(sessionId, { ...getComputerUsePipSnapshot(sessionId), ended })
  emitChange()
}

/** Drop a single session's snapshot (on session switch / component unmount). */
export function clearComputerUsePipSession(sessionId: string): void {
  snapshots.delete(sessionId)
  emitChange()
}

export function setComputerUsePipAlwaysHidden(hidden: boolean): void {
  alwaysHidden = hidden
  emitChange()
}

export function getComputerUsePipAlwaysHidden(): boolean {
  return alwaysHidden
}

export function useComputerUsePipAlwaysHidden(): boolean {
  return useSyncExternalStore(
    subscribeComputerUsePip,
    getComputerUsePipAlwaysHidden,
    getComputerUsePipAlwaysHidden
  )
}

export function useComputerUsePip(sessionId: string): ComputerUsePipSnapshot {
  return useSyncExternalStore(
    subscribeComputerUsePip,
    () => getComputerUsePipSnapshot(sessionId),
    () => getComputerUsePipSnapshot(sessionId)
  )
}

/** Test and session-lifecycle utility. */
export function clearComputerUsePipState(): void {
  snapshots.clear()
  alwaysHidden = false
  emitChange()
}
