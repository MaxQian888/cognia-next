import { useSyncExternalStore } from "react"

export type ComputerUsePipPhase = "idle" | "running" | "complete" | "error"
export type ComputerUsePipAlignment = "topLeft" | "topRight" | "bottomLeft" | "bottomRight"

export interface ComputerUsePipLayoutPreference {
  alignment: ComputerUsePipAlignment
  preferredLongEdge: number
}

export const COMPUTER_USE_PIP_LAYOUT_STORAGE_KEY = "cognia-computer-use-pip-layout:v1"
export const DEFAULT_COMPUTER_USE_PIP_LAYOUT: ComputerUsePipLayoutPreference = {
  alignment: "bottomRight",
  preferredLongEdge: 250,
}

export interface ComputerUsePipResult {
  ok: boolean
  output?: string
  error?: string
  display_width_px?: number
  display_height_px?: number
}

export interface ComputerUsePipSnapshot {
  runId: number | null
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
  /** Temporarily removed from paint while the desktop capture is in flight. */
  captureSuppressed: boolean
  frame: { src: string; width: number; height: number; capturedAt: number } | null
}

const EMPTY_SNAPSHOT: ComputerUsePipSnapshot = {
  runId: null,
  action: null,
  phase: "idle",
  error: null,
  hidden: false,
  dismissed: false,
  ended: false,
  captureSuppressed: false,
  frame: null,
}

interface InternalComputerUsePipSnapshot extends ComputerUsePipSnapshot {
  latestActivityId: number
  captureSuppressionCount: number
}

const snapshots = new Map<string, InternalComputerUsePipSnapshot>()
const listeners = new Set<() => void>()
let alwaysHidden = false
let nextActivityId = 1
let layoutPreference: ComputerUsePipLayoutPreference | null = null

const PIP_ALIGNMENTS = new Set<ComputerUsePipAlignment>([
  "topLeft",
  "topRight",
  "bottomLeft",
  "bottomRight",
])

function normalizeLayoutPreference(value: unknown): ComputerUsePipLayoutPreference {
  if (!value || typeof value !== "object") return DEFAULT_COMPUTER_USE_PIP_LAYOUT
  const candidate = value as Partial<ComputerUsePipLayoutPreference>
  const alignment = PIP_ALIGNMENTS.has(candidate.alignment as ComputerUsePipAlignment)
    ? (candidate.alignment as ComputerUsePipAlignment)
    : DEFAULT_COMPUTER_USE_PIP_LAYOUT.alignment
  const preferredLongEdge =
    Number.isFinite(candidate.preferredLongEdge) && (candidate.preferredLongEdge ?? 0) > 0
      ? Math.min(2000, Math.max(220, Math.round(candidate.preferredLongEdge as number)))
      : DEFAULT_COMPUTER_USE_PIP_LAYOUT.preferredLongEdge
  return { alignment, preferredLongEdge }
}

function loadLayoutPreference(): ComputerUsePipLayoutPreference {
  if (typeof window === "undefined") return DEFAULT_COMPUTER_USE_PIP_LAYOUT
  try {
    const raw = window.localStorage.getItem(COMPUTER_USE_PIP_LAYOUT_STORAGE_KEY)
    return raw ? normalizeLayoutPreference(JSON.parse(raw)) : DEFAULT_COMPUTER_USE_PIP_LAYOUT
  } catch {
    return DEFAULT_COMPUTER_USE_PIP_LAYOUT
  }
}

export function getComputerUsePipLayoutPreference(): ComputerUsePipLayoutPreference {
  layoutPreference ??= loadLayoutPreference()
  return layoutPreference
}

export function setComputerUsePipLayoutPreference(
  preference: ComputerUsePipLayoutPreference
): void {
  layoutPreference = normalizeLayoutPreference(preference)
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        COMPUTER_USE_PIP_LAYOUT_STORAGE_KEY,
        JSON.stringify(layoutPreference)
      )
    } catch {
      // Storage can be disabled; the in-memory preference still applies.
    }
  }
  emitChange()
}

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
  result?: ComputerUsePipResult,
  sourceActivityId?: number | null
): number | null {
  if (!sessionId) return null
  const current = getComputerUsePipSnapshot(sessionId)
  const running = result == null
  const activityId = running ? nextActivityId++ : (sourceActivityId ?? nextActivityId++)
  const internalCurrent = snapshots.get(sessionId)
  const latestActivityId = internalCurrent?.latestActivityId ?? 0
  // A running action published after the previous turn ended marks the start of
  // a fresh run: re-expand a manually/auto-collapsed surface. Within a live run
  // a manual hide must persist, so `hidden` is only reset at this boundary.
  const startingNewRun = running && current.ended
  const nextFrame =
    action === "screenshot" &&
    result?.ok &&
    result.output &&
    Number.isFinite(result.display_width_px) &&
    Number.isFinite(result.display_height_px) &&
    (result.display_width_px ?? 0) > 0 &&
    (result.display_height_px ?? 0) > 0
      ? {
          src: `data:image/png;base64,${result.output}`,
          width: result.display_width_px as number,
          height: result.display_height_px as number,
          capturedAt: Date.now(),
        }
      : current.frame

  if (
    !running &&
    sourceActivityId != null &&
    internalCurrent != null &&
    sourceActivityId !== latestActivityId
  ) {
    snapshots.set(sessionId, {
      ...current,
      latestActivityId,
      captureSuppressionCount: internalCurrent?.captureSuppressionCount ?? 0,
      frame: nextFrame,
    })
    emitChange()
    return activityId
  }

  snapshots.set(sessionId, {
    ...current,
    latestActivityId: activityId,
    captureSuppressionCount: internalCurrent?.captureSuppressionCount ?? 0,
    action,
    phase: running ? "running" : result.ok ? "complete" : "error",
    error: result?.ok === false ? (result.error ?? null) : null,
    hidden: startingNewRun ? false : current.hidden,
    dismissed: startingNewRun ? false : current.dismissed,
    ended: false,
    frame: nextFrame,
  })
  emitChange()
  return activityId
}

/** Update only the visual frame while preserving the current action ordering. */
export function publishComputerUsePipFrame(
  sessionId: string | undefined,
  frame: { output: string; width: number; height: number; capturedAt?: number }
): void {
  if (
    !sessionId ||
    !frame.output ||
    !Number.isFinite(frame.width) ||
    !Number.isFinite(frame.height) ||
    frame.width <= 0 ||
    frame.height <= 0
  ) {
    return
  }
  const current = snapshots.get(sessionId)
  if (!current) return
  snapshots.set(sessionId, {
    ...current,
    frame: {
      src: `data:image/png;base64,${frame.output}`,
      width: frame.width,
      height: frame.height,
      capturedAt: frame.capturedAt ?? Date.now(),
    },
  })
  emitChange()
}

/** Reset transient visibility and frame state at an explicit chat-run boundary. */
export function beginComputerUsePipRun(sessionId: string, runId: number): void {
  const current = snapshots.get(sessionId)
  if (current?.runId === runId) return
  if (current && current.runId == null && current.action != null) {
    snapshots.set(sessionId, { ...current, runId })
    emitChange()
    return
  }
  snapshots.set(sessionId, {
    ...EMPTY_SNAPSHOT,
    runId,
    latestActivityId: current?.latestActivityId ?? 0,
    captureSuppressionCount: 0,
  })
  emitChange()
}

function waitForOverlayToLeavePaint(): Promise<void> {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    return Promise.resolve()
  }
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      resolve()
    }
    const timeout = window.setTimeout(finish, 100)
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(finish)
    })
  })
}

/**
 * Remove the PiP from paint before a desktop screenshot and return an idempotent
 * release callback. A counter makes overlapping captures safe.
 */
export async function suppressComputerUsePipForCapture(
  sessionId: string | undefined
): Promise<() => void> {
  if (!sessionId) return () => {}
  const current = snapshots.get(sessionId)
  const captureSuppressionCount = (current?.captureSuppressionCount ?? 0) + 1
  snapshots.set(sessionId, {
    ...(current ?? EMPTY_SNAPSHOT),
    latestActivityId: current?.latestActivityId ?? 0,
    captureSuppressionCount,
    captureSuppressed: true,
  })
  emitChange()
  await waitForOverlayToLeavePaint()

  let released = false
  return () => {
    if (released) return
    released = true
    const latest = snapshots.get(sessionId)
    if (!latest) return
    const remaining = Math.max(0, latest.captureSuppressionCount - 1)
    snapshots.set(sessionId, {
      ...latest,
      captureSuppressionCount: remaining,
      captureSuppressed: remaining > 0,
    })
    emitChange()
  }
}

export function setComputerUsePipHidden(sessionId: string, hidden: boolean): void {
  const current = snapshots.get(sessionId)
  snapshots.set(sessionId, {
    ...getComputerUsePipSnapshot(sessionId),
    latestActivityId: current?.latestActivityId ?? 0,
    captureSuppressionCount: current?.captureSuppressionCount ?? 0,
    hidden,
  })
  emitChange()
}

/** Fully dismiss the surface for the current run (no pill until the next run). */
export function setComputerUsePipDismissed(sessionId: string, dismissed: boolean): void {
  const current = snapshots.get(sessionId)
  snapshots.set(sessionId, {
    ...getComputerUsePipSnapshot(sessionId),
    latestActivityId: current?.latestActivityId ?? 0,
    captureSuppressionCount: current?.captureSuppressionCount ?? 0,
    dismissed,
  })
  emitChange()
}

/** Mark the session's turn as finished so the UI can show a terminal state. */
export function setComputerUsePipRunEnded(sessionId: string, ended = true): void {
  const current = snapshots.get(sessionId)
  snapshots.set(sessionId, {
    ...getComputerUsePipSnapshot(sessionId),
    latestActivityId: current?.latestActivityId ?? 0,
    captureSuppressionCount: current?.captureSuppressionCount ?? 0,
    ended,
  })
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
  nextActivityId = 1
  layoutPreference = null
  emitChange()
}
