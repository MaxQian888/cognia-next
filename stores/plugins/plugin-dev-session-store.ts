import { create } from "zustand"

import type {
  PluginActivationProof,
  PluginDevReloadResult,
} from "@/lib/cli-bridge/handlers/plugin-dev-reload"
import type { PluginType } from "@/types/plugin"

const MAX_SESSIONS = 10
const MAX_ATTEMPTS = 50
const MAX_DIAGNOSTICS = 50
const STALE_AFTER_MS = 15_000
const STAGE_ORDER: PluginDevAttemptStage[] = [
  "detected",
  "building",
  "installing",
  "discovering",
  "quiescing",
  "activating",
  "verifying",
  "active",
]

export type PluginDevSessionState =
  "idle" | "starting" | "watching" | "stopping" | "stopped" | "stale"

export type PluginDevAttemptState =
  | "detected"
  | "building"
  | "installing"
  | "active"
  | "build_failed"
  | "reload_failed"
  | "restart_required"

export type PluginDevAttemptStage =
  | "detected"
  | "building"
  | "installing"
  | "discovering"
  | "quiescing"
  | "activating"
  | "verifying"
  | "active"

export type PluginDevSessionEventName =
  | "session_started"
  | "heartbeat"
  | "change_detected"
  | "build_started"
  | "build_succeeded"
  | "build_failed"
  | "session_stopping"
  | "session_stopped"

export interface PluginDevSessionEvent {
  schemaVersion: 1
  sessionId: string
  attempt: number
  event: PluginDevSessionEventName
  projectName?: string | null
  stage?: string | null
  occurredAt: string
  summary?: string | null
  durationMs?: number | null
}

export interface PluginDevAttempt {
  attempt: number
  state: PluginDevAttemptState
  stages: PluginDevAttemptStage[]
  startedAt: number
  updatedAt: number
  durationMs?: number
  diagnostics: string[]
  activationProof?: PluginActivationProof
}

export interface PluginDevSession {
  id: string
  state: PluginDevSessionState
  startedAt: number
  lastSeenAt: number
  projectName?: string
  pluginId?: string
  pluginType?: PluginType
  terminalSessionId?: string
  attempts: PluginDevAttempt[]
}

interface PluginDevSessionStore {
  sessions: PluginDevSession[]
  ingest: (event: PluginDevSessionEvent) => void
  recordReloadResult: (result: PluginDevReloadResult) => void
  attachTerminal: (sessionId: string, terminalSessionId: string) => void
  markStale: (now?: number) => void
  clear: () => void
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function eventStage(event: PluginDevSessionEventName): PluginDevAttemptStage | undefined {
  switch (event) {
    case "change_detected":
      return "detected"
    case "build_started":
      return "building"
    case "build_succeeded":
      return "installing"
    default:
      return undefined
  }
}

function eventAttemptState(event: PluginDevSessionEventName): PluginDevAttemptState | undefined {
  switch (event) {
    case "change_detected":
      return "detected"
    case "build_started":
      return "building"
    case "build_succeeded":
      return "installing"
    case "build_failed":
      return "build_failed"
    default:
      return undefined
  }
}

function upsertAttempt(
  attempts: PluginDevAttempt[],
  input: {
    attempt: number
    state: PluginDevAttemptState
    stage?: PluginDevAttemptStage
    stages?: PluginDevAttemptStage[]
    at: number
    durationMs?: number | null
    diagnostic?: string | null
    activationProof?: PluginActivationProof
  }
): PluginDevAttempt[] {
  if (input.attempt <= 0) return attempts
  const current = attempts.find((attempt) => attempt.attempt === input.attempt)
  const stages = current?.stages ?? []
  const requestedStages = [...(input.stages ?? []), ...(input.stage ? [input.stage] : [])]
  const nextStages = [...stages]
  for (const stage of requestedStages) {
    if (!nextStages.includes(stage)) nextStages.push(stage)
  }
  nextStages.sort((left, right) => STAGE_ORDER.indexOf(left) - STAGE_ORDER.indexOf(right))
  const diagnostics = current?.diagnostics ?? []
  const nextDiagnostics =
    input.diagnostic && !diagnostics.includes(input.diagnostic)
      ? [...diagnostics, input.diagnostic].slice(-MAX_DIAGNOSTICS)
      : diagnostics
  const next: PluginDevAttempt = {
    attempt: input.attempt,
    state: !current || input.at >= current.updatedAt ? input.state : current.state,
    stages: nextStages,
    startedAt: current?.startedAt ?? input.at,
    updatedAt: Math.max(current?.updatedAt ?? 0, input.at),
    diagnostics: nextDiagnostics,
    ...(input.durationMs != null ? { durationMs: input.durationMs } : {}),
    ...(input.activationProof ? { activationProof: input.activationProof } : {}),
  }
  return [next, ...attempts.filter((attempt) => attempt.attempt !== input.attempt)]
    .sort((left, right) => right.attempt - left.attempt)
    .slice(0, MAX_ATTEMPTS)
}

function sessionState(event: PluginDevSessionEventName): PluginDevSessionState {
  switch (event) {
    case "session_started":
      return "starting"
    case "session_stopping":
      return "stopping"
    case "session_stopped":
      return "stopped"
    default:
      return "watching"
  }
}

export const usePluginDevSessionStore = create<PluginDevSessionStore>((set) => ({
  sessions: [],
  ingest: (event) =>
    set((state) => {
      const at = timestamp(event.occurredAt)
      const current = state.sessions.find((session) => session.id === event.sessionId)
      const attemptState = eventAttemptState(event.event)
      const incomingSessionState = sessionState(event.event)
      const next: PluginDevSession = {
        id: event.sessionId,
        state:
          current?.state === "stopped"
            ? "stopped"
            : current && at < current.lastSeenAt
              ? current.state
              : event.event === "session_started" && current?.state === "watching"
                ? "watching"
                : incomingSessionState,
        startedAt: Math.min(current?.startedAt ?? at, at),
        lastSeenAt: Math.max(current?.lastSeenAt ?? 0, at),
        ...(event.projectName || current?.projectName
          ? { projectName: event.projectName ?? current?.projectName }
          : {}),
        ...(current?.pluginId ? { pluginId: current.pluginId } : {}),
        ...(current?.pluginType ? { pluginType: current.pluginType } : {}),
        ...(current?.terminalSessionId ? { terminalSessionId: current.terminalSessionId } : {}),
        attempts: attemptState
          ? upsertAttempt(current?.attempts ?? [], {
              attempt: event.attempt,
              state: attemptState,
              stage: eventStage(event.event),
              at,
              durationMs: event.durationMs,
              diagnostic: event.summary,
            })
          : (current?.attempts ?? []),
      }
      return {
        sessions: [
          next,
          ...state.sessions.filter((session) => session.id !== event.sessionId),
        ].slice(0, MAX_SESSIONS),
      }
    }),
  recordReloadResult: (result) =>
    set((state) => {
      const at = Date.now()
      const current = state.sessions.find((session) => session.id === result.sessionId)
      const attemptState: PluginDevAttemptState = result.ok
        ? "active"
        : result.outcome === "restart_required"
          ? "restart_required"
          : "reload_failed"
      const runtimeStages: PluginDevAttemptStage[] = result.ok
        ? ["discovering", "quiescing", "activating", "verifying", "active"]
        : result.stage === "install"
          ? ["installing"]
          : result.stage === "discover"
            ? ["discovering"]
            : result.stage === "quiesce"
              ? ["discovering", "quiescing"]
              : result.stage === "activate"
                ? ["discovering", "quiescing", "activating"]
                : ["discovering", "quiescing", "activating", "verifying"]
      const next: PluginDevSession = {
        id: result.sessionId,
        state: current?.state === "stopped" ? "stopped" : "watching",
        startedAt: current?.startedAt ?? at,
        lastSeenAt: at,
        ...(current?.projectName ? { projectName: current.projectName } : {}),
        pluginId: result.pluginId,
        ...(result.pluginType ? { pluginType: result.pluginType } : {}),
        ...(current?.terminalSessionId ? { terminalSessionId: current.terminalSessionId } : {}),
        attempts: upsertAttempt(current?.attempts ?? [], {
          attempt: result.attempt,
          state: attemptState,
          stages: runtimeStages,
          at,
          diagnostic: result.error?.message,
          activationProof: result.activationProof,
        }),
      }
      return {
        sessions: [
          next,
          ...state.sessions.filter((session) => session.id !== result.sessionId),
        ].slice(0, MAX_SESSIONS),
      }
    }),
  attachTerminal: (sessionId, terminalSessionId) =>
    set((state) => {
      const current = state.sessions.find((session) => session.id === sessionId)
      const now = Date.now()
      const next: PluginDevSession = current
        ? { ...current, terminalSessionId }
        : {
            id: sessionId,
            state: "starting",
            startedAt: now,
            lastSeenAt: now,
            terminalSessionId,
            attempts: [],
          }
      return {
        sessions: [next, ...state.sessions.filter((session) => session.id !== sessionId)].slice(
          0,
          MAX_SESSIONS
        ),
      }
    }),
  markStale: (now = Date.now()) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.state !== "stopped" &&
        session.state !== "stale" &&
        now - session.lastSeenAt > STALE_AFTER_MS
          ? { ...session, state: "stale" }
          : session
      ),
    })),
  clear: () => set({ sessions: [] }),
}))
