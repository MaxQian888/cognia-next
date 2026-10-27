import { useCallback, useSyncExternalStore } from "react"
import { screenshotMimeType } from "./model-frame"
import type { ActionResult, ImageFormat } from "./types"

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

export interface ComputerUsePipPresentation {
  id: string
  label?: string
}

export interface ComputerUsePipSnapshot {
  presentationId?: string
  label?: string
  frameUnavailable?: boolean
  /** Authoritative desktop target from the tool context; null means this host. */
  targetConnectionId?: string | null
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
  runStartActivityId?: number
  frameActivityId?: number
}

const snapshots = new Map<string, InternalComputerUsePipSnapshot>()
const listeners = new Set<() => void>()
const preferenceListeners = new Set<() => void>()
const captureListeners = new Set<() => void>()
const scopedListeners = new Map<string, Set<() => void>>()
const collectionListeners = new Map<string, Set<() => void>>()
const owners = new Map<string, { sessionId: string; id: string }>()
const presentationIds = new Map<string, readonly string[]>()
const latestKeys = new Map<string, string>()
const activityOwners = new Map<number, { key: string; sessionId: string }>()
const retainedSessions = new Map<string, number>()
const retainedPresentations = new Map<string, number>()
const touchedAt = new Map<string, number>()
const sessionRuns = new Map<string, { runId: number; boundary: number; active: boolean }>()
const EMPTY_IDS: readonly string[] = []
export const COMPUTER_USE_PIP_RETENTION_MS = 60_000
const MAX_INACTIVE_SESSIONS = 32
const MAX_INACTIVE_FRAME_CHARS = 16 * 1024 * 1024
const MAX_CACHED_FRAMES = 8
let retirementTimer: ReturnType<typeof setTimeout> | null = null
let globalCaptureCount = 0
let stateGeneration = 0

function presentationKey(sessionId: string, id: string): string {
  return JSON.stringify([sessionId, id])
}

function subscribeTo(map: Map<string, Set<() => void>>, key: string, listener: () => void) {
  const bucket = map.get(key) ?? new Set<() => void>()
  map.set(key, bucket)
  bucket.add(listener)
  return () => {
    bucket.delete(listener)
    if (!bucket.size) map.delete(key)
  }
}

function keyFor(
  sessionId: string,
  activityId?: number | null,
  presentation?: ComputerUsePipPresentation
): string {
  const owned = activityId != null ? activityOwners.get(activityId) : undefined
  if (owned?.sessionId === sessionId && owners.has(owned.key)) return owned.key
  const id = presentation?.id ?? "desktop"
  const key = presentationKey(sessionId, id)
  owners.set(key, { sessionId, id })
  if (!snapshots.has(key)) {
    const run = sessionRuns.get(sessionId)
    writeSnapshot(key, {
      ...EMPTY_SNAPSHOT,
      runId: run?.runId ?? null,
      runStartActivityId: run?.boundary,
      latestActivityId: 0,
      captureSuppressionCount: 0,
    })
  }
  if (!latestKeys.has(sessionId)) latestKeys.set(sessionId, key)
  return key
}

function readSnapshot(key: string): ComputerUsePipSnapshot {
  return snapshots.get(key) ?? EMPTY_SNAPSHOT
}

function removeKey(key: string, invalidateActivities = false) {
  const owner = owners.get(key)
  snapshots.delete(key)
  touchedAt.delete(key)
  if (!owner) return
  owners.delete(key)
  if (invalidateActivities)
    for (const [id, activityKey] of activityOwners)
      if (activityKey.key === key) activityOwners.delete(id)
  const ids = presentationIds.get(owner.sessionId) ?? EMPTY_IDS
  const remaining = ids.filter((id) => id !== owner.id)
  if (remaining.length !== ids.length) {
    if (remaining.length) presentationIds.set(owner.sessionId, remaining)
    else presentationIds.delete(owner.sessionId)
    for (const listener of collectionListeners.get(owner.sessionId) ?? []) listener()
  }
  if (latestKeys.get(owner.sessionId) === key) {
    const last = remaining.at(-1)
    if (last) latestKeys.set(owner.sessionId, presentationKey(owner.sessionId, last))
    else latestKeys.delete(owner.sessionId)
  }
  if (
    invalidateActivities &&
    ![...owners.values()].some((other) => other.sessionId === owner.sessionId)
  )
    sessionRuns.delete(owner.sessionId)
  emitChange(key, owner.sessionId)
}

function retireSnapshots() {
  const now = Date.now()
  const inactive = [...snapshots.keys()]
    .filter((key) => {
      const owner = owners.get(key)
      return (
        owner &&
        !retainedSessions.has(owner.sessionId) &&
        (snapshots.get(key)?.ended ||
          (!sessionRuns.get(owner.sessionId)?.active && snapshots.get(key)?.phase !== "running"))
      )
    })
    .sort((a, b) => (touchedAt.get(a) ?? 0) - (touchedAt.get(b) ?? 0))
  const sessions = new Set(inactive.map((key) => owners.get(key)!.sessionId))
  let frameChars = inactive.reduce((n, key) => n + (snapshots.get(key)?.frame?.src.length ?? 0), 0)
  for (const key of inactive) {
    const snapshot = snapshots.get(key)
    if (!snapshot) continue
    const sessionId = owners.get(key)!.sessionId
    if (
      now - (touchedAt.get(key) ?? 0) >= COMPUTER_USE_PIP_RETENTION_MS ||
      sessions.size > MAX_INACTIVE_SESSIONS
    ) {
      frameChars -= snapshot.frame?.src.length ?? 0
      removeKey(key, true)
      if (![...owners.values()].some((owner) => owner.sessionId === sessionId))
        sessions.delete(sessionId)
    } else if (frameChars > MAX_INACTIVE_FRAME_CHARS && snapshot.frame) {
      frameChars -= snapshot.frame.src.length
      snapshots.set(key, { ...snapshot, frame: null, frameUnavailable: true })
      emitChange(key)
    }
  }
  // Mounted cards own their frames. The remaining target/session cache is
  // bounded independently, even while an offscreen producer is still running.
  const cached = [...snapshots.keys()]
    .filter((key) => snapshots.get(key)?.frame && !retainedPresentations.has(key))
    .sort((a, b) => (touchedAt.get(a) ?? 0) - (touchedAt.get(b) ?? 0))
  let cachedChars = cached.reduce((n, key) => n + snapshots.get(key)!.frame!.src.length, 0)
  let cachedCount = cached.length
  for (const key of cached) {
    if (cachedCount <= MAX_CACHED_FRAMES && cachedChars <= MAX_INACTIVE_FRAME_CHARS) break
    const snapshot = snapshots.get(key)!
    cachedChars -= snapshot.frame!.src.length
    cachedCount--
    snapshots.set(key, { ...snapshot, frame: null, frameUnavailable: true })
    emitChange(key)
  }
  if (!snapshots.size) {
    if (retirementTimer) clearTimeout(retirementTimer)
    retirementTimer = null
  }
}

function writeSnapshot(key: string, snapshot: InternalComputerUsePipSnapshot) {
  const owner = owners.get(key)
  snapshots.set(key, { ...snapshot, presentationId: owner?.id, label: snapshot.label })
  touchedAt.set(key, Date.now())
  if (owner && snapshot.action) {
    const ids = presentationIds.get(owner.sessionId) ?? EMPTY_IDS
    if (!ids.includes(owner.id)) {
      presentationIds.set(owner.sessionId, [...ids, owner.id])
      for (const listener of collectionListeners.get(owner.sessionId) ?? []) listener()
    }
  }
  retireSnapshots()
  // Renderer-only cache lifetime; Node/Host callers retire lazily on writes.
  if (typeof window !== "undefined" && !retirementTimer && snapshots.size)
    retirementTimer = setTimeout(function sweep() {
      retirementTimer = null
      retireSnapshots()
      if (snapshots.size) {
        retirementTimer = setTimeout(sweep, COMPUTER_USE_PIP_RETENTION_MS)
        if (typeof retirementTimer === "object") retirementTimer.unref?.()
      }
    }, COMPUTER_USE_PIP_RETENTION_MS)
  if (retirementTimer && typeof retirementTimer === "object") retirementTimer.unref?.()
}

export function retainComputerUsePipSession(sessionId: string): () => void {
  const generation = stateGeneration
  retainedSessions.set(sessionId, (retainedSessions.get(sessionId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    if (generation !== stateGeneration) return
    const count = (retainedSessions.get(sessionId) ?? 1) - 1
    if (count > 0) retainedSessions.set(sessionId, count)
    else {
      retainedSessions.delete(sessionId)
      retireSnapshots()
    }
  }
}

export function retainComputerUsePipPresentation(sessionId: string, id: string): () => void {
  const generation = stateGeneration
  const key = presentationKey(sessionId, id)
  retainedPresentations.set(key, (retainedPresentations.get(key) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    if (generation !== stateGeneration) return
    const count = (retainedPresentations.get(key) ?? 1) - 1
    if (count > 0) retainedPresentations.set(key, count)
    else {
      retainedPresentations.delete(key)
      retireSnapshots()
    }
  }
}

export function getComputerUsePipPresentationIds(sessionId: string): readonly string[] {
  return presentationIds.get(sessionId) ?? EMPTY_IDS
}

export function useComputerUsePipPresentationIds(sessionId: string): readonly string[] {
  return useSyncExternalStore(
    useCallback((listener) => subscribeTo(collectionListeners, sessionId, listener), [sessionId]),
    () => getComputerUsePipPresentationIds(sessionId),
    () => EMPTY_IDS
  )
}

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

function emitChange(key?: string, sessionId?: string): void {
  for (const listener of listeners) listener()
  if (!key) return
  const owner = sessionId ?? owners.get(key)?.sessionId
  for (const listener of scopedListeners.get(key) ?? []) listener()
  if (owner) for (const listener of scopedListeners.get(owner) ?? []) listener()
}

export function getComputerUsePipSnapshot(
  sessionId: string,
  presentationId?: string
): ComputerUsePipSnapshot {
  const key =
    presentationId === undefined
      ? latestKeys.get(sessionId)
      : presentationKey(sessionId, presentationId)
  if (key && snapshots.has(key)) return readSnapshot(key)
  const fallback = snapshots.get(presentationKey(sessionId, "desktop"))
  return fallback?.action == null ? (fallback ?? EMPTY_SNAPSHOT) : EMPTY_SNAPSHOT
}

export function subscribeComputerUsePip(
  listener: () => void,
  sessionId?: string,
  presentationId?: string
): () => void {
  if (sessionId)
    return subscribeTo(
      scopedListeners,
      presentationId === undefined ? sessionId : presentationKey(sessionId, presentationId),
      listener
    )
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publishComputerUseActivity(
  sessionId: string | undefined,
  action: string,
  result?: ComputerUsePipResult,
  sourceActivityId?: number | null,
  targetConnectionId?: string | null,
  presentation?: ComputerUsePipPresentation
): number | null {
  if (!sessionId) return null
  if (sourceActivityId != null && activityOwners.get(sourceActivityId)?.sessionId !== sessionId)
    return sourceActivityId
  const chatSessionId = sessionId
  sessionId = keyFor(sessionId, sourceActivityId, presentation)
  const current = readSnapshot(sessionId)
  const running = result == null
  const activityId = running ? nextActivityId++ : (sourceActivityId ?? nextActivityId++)
  if (running || sourceActivityId == null) latestKeys.set(chatSessionId, sessionId)
  activityOwners.set(activityId, { key: sessionId, sessionId: chatSessionId })
  if (activityOwners.size > 4096) activityOwners.delete(activityOwners.keys().next().value!)
  const internalCurrent = snapshots.get(sessionId)
  const latestActivityId = internalCurrent?.latestActivityId ?? 0
  if (
    !running &&
    sourceActivityId != null &&
    sourceActivityId < (internalCurrent?.runStartActivityId ?? 0)
  )
    return activityId
  // A running action published after the previous turn ended marks the start of
  // a fresh run: re-expand a manually/auto-collapsed surface. Within a live run
  // a manual hide must persist, so `hidden` is only reset at this boundary.
  const startingNewRun = running && current.ended
  const targetChanged =
    running && targetConnectionId !== undefined && targetConnectionId !== current.targetConnectionId
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
      : startingNewRun || targetChanged
        ? null
        : current.frame

  if (
    !running &&
    sourceActivityId != null &&
    internalCurrent != null &&
    internalCurrent.action != null &&
    sourceActivityId !== latestActivityId
  ) {
    writeSnapshot(sessionId, {
      ...current,
      latestActivityId,
      captureSuppressionCount: internalCurrent?.captureSuppressionCount ?? 0,
      frame: nextFrame,
    })
    emitChange(sessionId)
    return activityId
  }

  writeSnapshot(sessionId, {
    ...current,
    targetConnectionId:
      targetConnectionId !== undefined ? targetConnectionId : current.targetConnectionId,
    captureSuppressed: startingNewRun || targetChanged ? false : current.captureSuppressed,
    runStartActivityId:
      startingNewRun || targetChanged ? activityId : internalCurrent?.runStartActivityId,
    latestActivityId: activityId,
    captureSuppressionCount:
      startingNewRun || targetChanged ? 0 : (internalCurrent?.captureSuppressionCount ?? 0),
    label: presentation?.label ?? current.label,
    action,
    phase: running ? "running" : result.ok ? "complete" : "error",
    error: result?.ok === false ? (result.error ?? null) : null,
    hidden: startingNewRun ? false : current.hidden,
    dismissed: startingNewRun ? false : current.dismissed,
    ended: running ? false : current.ended,
    frame: nextFrame,
  })
  emitChange(sessionId)
  return activityId
}

/** Resolve target identity without giving a delayed context resolver a new activity. */
export function setComputerUsePipTarget(
  sessionId: string | undefined,
  activityId: number | null,
  targetConnectionId: string | null
): void {
  if (!sessionId || activityId == null) return
  if (activityOwners.get(activityId)?.sessionId !== sessionId) return
  sessionId = keyFor(sessionId, activityId)
  const current = snapshots.get(sessionId)
  if (
    !current ||
    current.latestActivityId !== activityId ||
    activityId < (current.runStartActivityId ?? 0) ||
    current.targetConnectionId === targetConnectionId
  )
    return
  writeSnapshot(sessionId, {
    ...current,
    targetConnectionId,
    frame: null,
    runStartActivityId: activityId,
    captureSuppressionCount: 0,
    captureSuppressed: false,
  })
  emitChange(sessionId)
}

/** Update only the visual frame while preserving the current action ordering. */
export function publishComputerUsePipFrame(
  sessionId: string | undefined,
  frame: {
    output: string
    width: number
    height: number
    capturedAt?: number
    format?: ImageFormat
    targetConnectionId?: string | null
  },
  sourceActivityId?: number | null
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
  if (sourceActivityId != null && activityOwners.get(sourceActivityId)?.sessionId !== sessionId)
    return
  sessionId = keyFor(sessionId, sourceActivityId)
  const current = snapshots.get(sessionId)
  if (!current) return
  if (
    frame.targetConnectionId !== undefined &&
    frame.targetConnectionId !== current.targetConnectionId
  )
    return
  if (
    sourceActivityId != null &&
    (sourceActivityId < (current.runStartActivityId ?? 0) ||
      sourceActivityId < (current.frameActivityId ?? 0))
  ) {
    return
  }
  const capturedAt = frame.capturedAt ?? Date.now()
  if (!Number.isFinite(capturedAt) || (current.frame && capturedAt < current.frame.capturedAt))
    return
  const src = `data:${screenshotMimeType(frame.format ?? "png")};base64,${frame.output}`
  if (
    current.frame?.src === src &&
    current.frame.width === frame.width &&
    current.frame.height === frame.height &&
    current.frame.capturedAt === capturedAt
  ) {
    // A visually identical result still owns the frame over older activities.
    if (sourceActivityId != null && sourceActivityId !== current.frameActivityId)
      writeSnapshot(sessionId, { ...current, frameActivityId: sourceActivityId })
    return
  }
  writeSnapshot(sessionId, {
    ...current,
    frameActivityId: sourceActivityId ?? current.frameActivityId,
    frameUnavailable: false,
    frame: {
      src,
      width: frame.width,
      height: frame.height,
      capturedAt,
    },
  })
  emitChange(sessionId)
}

/** Reset transient visibility and frame state at an explicit chat-run boundary. */
export function beginComputerUsePipRun(sessionId: string, runId: number): void {
  const previousRun = sessionRuns.get(sessionId)
  if (previousRun?.runId !== runId)
    sessionRuns.set(sessionId, { runId, boundary: nextActivityId, active: true })
  const keys = [...owners].filter(([, owner]) => owner.sessionId === sessionId).map(([key]) => key)
  const defaultKey = keyFor(sessionId)
  if (!keys.includes(defaultKey)) keys.push(defaultKey)
  for (const key of keys) {
    const current = snapshots.get(key)
    if (current?.runId === runId) continue
    if (current?.runId != null && owners.get(key)?.id !== "desktop") {
      removeKey(key, true)
      continue
    }
    if (current && current.runId == null && current.action != null) {
      writeSnapshot(key, { ...current, runId })
    } else {
      writeSnapshot(key, {
        ...EMPTY_SNAPSHOT,
        runId,
        runStartActivityId: nextActivityId,
        latestActivityId: current?.latestActivityId ?? 0,
        captureSuppressionCount: 0,
      })
      const owner = owners.get(key)!
      const ids = presentationIds.get(sessionId) ?? EMPTY_IDS
      if (ids.includes(owner.id)) {
        presentationIds.set(
          sessionId,
          ids.filter((id) => id !== owner.id)
        )
        for (const listener of collectionListeners.get(sessionId) ?? []) listener()
      }
    }
    emitChange(key)
  }
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
  sessionId: string | undefined,
  scope: "session" | "local-desktop" | "none" = "session"
): Promise<() => void> {
  if (scope === "none") return () => {}
  if (scope === "local-desktop") {
    const generation = stateGeneration
    globalCaptureCount++
    for (const listener of captureListeners) listener()
    await waitForOverlayToLeavePaint()
    let released = false
    return () => {
      if (released) return
      released = true
      if (generation !== stateGeneration) return
      globalCaptureCount = Math.max(0, globalCaptureCount - 1)
      for (const listener of captureListeners) listener()
    }
  }
  if (!sessionId) return () => {}
  sessionId = keyFor(sessionId)
  const current = snapshots.get(sessionId)
  const captureSuppressionCount = (current?.captureSuppressionCount ?? 0) + 1
  writeSnapshot(sessionId, {
    ...(current ?? EMPTY_SNAPSHOT),
    latestActivityId: current?.latestActivityId ?? 0,
    captureSuppressionCount,
    captureSuppressed: true,
  })
  emitChange(sessionId)
  const runBoundary = current?.runStartActivityId
  await waitForOverlayToLeavePaint()

  let released = false
  return () => {
    if (released) return
    released = true
    const latest = snapshots.get(sessionId)
    if (!latest) return
    if (latest.runStartActivityId !== runBoundary) return
    const remaining = Math.max(0, latest.captureSuppressionCount - 1)
    writeSnapshot(sessionId, {
      ...latest,
      captureSuppressionCount: remaining,
      captureSuppressed: remaining > 0,
    })
    emitChange(sessionId)
  }
}

/** Preserve tool results while publishing run-scoped operator feedback. */
export async function withComputerUsePipActivity<T>(
  sessionId: string | undefined,
  action: string,
  run: (activityId: number | null) => Promise<T>,
  targetConnectionId?: string | null,
  presentation?: ComputerUsePipPresentation
): Promise<T> {
  const activityId = publishComputerUseActivity(
    sessionId,
    action,
    undefined,
    undefined,
    targetConnectionId,
    presentation
  )
  try {
    const result = await run(activityId)
    const outcome =
      result && typeof result === "object" && "status" in result
        ? (result as Partial<ActionResult>)
        : null
    const failed = outcome && ["refused", "notDelivered", "unknown"].includes(outcome.status ?? "")
    publishComputerUseActivity(
      sessionId,
      action,
      {
        ok: !failed,
        error: failed
          ? (outcome.policyDecision?.reason ??
              outcome.evidence?.map((item) => item.message).join("; ")) ||
            undefined
          : undefined,
      },
      activityId
    )
    return result
  } catch (error) {
    publishComputerUseActivity(
      sessionId,
      action,
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      activityId
    )
    throw error
  }
}

export function setComputerUsePipHidden(
  sessionId: string,
  hidden: boolean,
  presentationId?: string
): void {
  sessionId =
    presentationId === undefined
      ? (latestKeys.get(sessionId) ?? keyFor(sessionId))
      : keyFor(sessionId, undefined, { id: presentationId })
  const current = snapshots.get(sessionId)
  writeSnapshot(sessionId, {
    ...readSnapshot(sessionId),
    latestActivityId: current?.latestActivityId ?? 0,
    captureSuppressionCount: current?.captureSuppressionCount ?? 0,
    hidden,
  })
  emitChange(sessionId)
}

/** Fully dismiss the surface for the current run (no pill until the next run). */
export function setComputerUsePipDismissed(
  sessionId: string,
  dismissed: boolean,
  presentationId?: string
): void {
  sessionId =
    presentationId === undefined
      ? (latestKeys.get(sessionId) ?? keyFor(sessionId))
      : keyFor(sessionId, undefined, { id: presentationId })
  const current = snapshots.get(sessionId)
  writeSnapshot(sessionId, {
    ...readSnapshot(sessionId),
    latestActivityId: current?.latestActivityId ?? 0,
    captureSuppressionCount: current?.captureSuppressionCount ?? 0,
    dismissed,
  })
  emitChange(sessionId)
}

/** Mark the session's turn as finished so the UI can show a terminal state. */
export function setComputerUsePipRunEnded(sessionId: string, ended = true): void {
  const run = sessionRuns.get(sessionId)
  if (run) run.active = !ended
  for (const [key, owner] of owners) {
    if (owner.sessionId !== sessionId) continue
    const current = snapshots.get(key)
    if (!current || current.ended === ended) continue
    writeSnapshot(key, { ...current, ended })
    emitChange(key)
  }
}

/** Retire an explicitly closed session; view unmounts only release retention. */
export function clearComputerUsePipSession(sessionId: string, invalidateActivities = false): void {
  for (const [key, owner] of owners)
    if (owner.sessionId === sessionId) removeKey(key, invalidateActivities)
  if (invalidateActivities) sessionRuns.delete(sessionId)
}

export function getComputerUsePipCaptureSuppressed(): boolean {
  return globalCaptureCount > 0
}
export function useComputerUsePipCaptureSuppressed(): boolean {
  return useSyncExternalStore(
    (listener) => {
      captureListeners.add(listener)
      return () => captureListeners.delete(listener)
    },
    getComputerUsePipCaptureSuppressed,
    () => false
  )
}

export function setComputerUsePipAlwaysHidden(hidden: boolean): void {
  if (alwaysHidden === hidden) return
  alwaysHidden = hidden
  for (const listener of preferenceListeners) listener()
  emitChange()
}

export function getComputerUsePipAlwaysHidden(): boolean {
  return alwaysHidden
}

export function useComputerUsePipAlwaysHidden(): boolean {
  return useSyncExternalStore(
    (listener) => {
      preferenceListeners.add(listener)
      return () => preferenceListeners.delete(listener)
    },
    getComputerUsePipAlwaysHidden,
    getComputerUsePipAlwaysHidden
  )
}

export function useComputerUsePip(
  sessionId: string,
  presentationId?: string
): ComputerUsePipSnapshot {
  return useSyncExternalStore(
    useCallback(
      (listener) => subscribeComputerUsePip(listener, sessionId, presentationId),
      [sessionId, presentationId]
    ),
    () => getComputerUsePipSnapshot(sessionId, presentationId),
    () => EMPTY_SNAPSHOT
  )
}

/** Test and session-lifecycle utility. */
export function clearComputerUsePipState(): void {
  stateGeneration++
  for (const key of [...snapshots.keys()]) removeKey(key)
  owners.clear()
  presentationIds.clear()
  latestKeys.clear()
  activityOwners.clear()
  touchedAt.clear()
  retainedSessions.clear()
  retainedPresentations.clear()
  sessionRuns.clear()
  if (retirementTimer) clearTimeout(retirementTimer)
  retirementTimer = null
  globalCaptureCount = 0
  alwaysHidden = false
  for (const listener of captureListeners) listener()
  for (const listener of preferenceListeners) listener()
  snapshots.clear()
  nextActivityId = 1
  layoutPreference = null
  emitChange()
}
