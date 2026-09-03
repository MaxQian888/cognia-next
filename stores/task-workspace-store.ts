"use client"

import { create } from "zustand"
import type {
  ResourceChange,
  TaskRun,
  TaskWorkspaceResourceEvent,
} from "@/lib/task-workspace/types"

export interface ActiveTaskRun {
  taskId: string
  runId: string
  sessionId: string
  workspaceRoot: string
  executionRoot: string
  state: TaskRun["state"]
  executionRunId?: string
  traceId?: string
  traceSpanId?: string
  surface?: string
  /**
   * The bundle turn this run belongs to, when it came from one.
   *
   * A bundle turn owns one run per distinct physical workspace, and only the
   * last activation survives in `activeBySession`. Settling that one run would
   * leave every additional root's run `running` forever, so the settle path
   * needs the turn, not the run it happens to be holding.
   */
  bundleTurnId?: string
}

interface TaskWorkspaceStore {
  activeBySession: Record<string, ActiveTaskRun>
  activeByRun: Record<string, ActiveTaskRun>
  resourcesByTask: Record<string, ResourceChange[]>
  provisionalByRun: Record<string, TaskWorkspaceResourceEvent>
  activate: (run: ActiveTaskRun) => void
  bindTrace: (sessionId: string, traceId: string, traceSpanId: string) => void
  reconcile: (sessionId: string, resources: ResourceChange[]) => void
  reconcileRun: (runId: string, resources: ResourceChange[]) => void
  ingestEvent: (event: TaskWorkspaceResourceEvent) => void
  clear: () => void
}

export const useTaskWorkspaceStore = create<TaskWorkspaceStore>((set) => ({
  activeBySession: {},
  activeByRun: {},
  resourcesByTask: {},
  provisionalByRun: {},
  activate: (run) =>
    set((state) => ({
      activeBySession: { ...state.activeBySession, [run.sessionId]: run },
      activeByRun: { ...state.activeByRun, [run.runId]: run },
    })),
  bindTrace: (sessionId, traceId, traceSpanId) =>
    set((state) => {
      const active = state.activeBySession[sessionId]
      if (!active) return state
      return {
        activeBySession: {
          ...state.activeBySession,
          [sessionId]: { ...active, traceId, traceSpanId },
        },
        activeByRun: {
          ...state.activeByRun,
          [active.runId]: { ...active, traceId, traceSpanId },
        },
      }
    }),
  reconcile: (sessionId, resources) =>
    set((state) => {
      const active = state.activeBySession[sessionId]
      if (!active) return state
      const provisionalByRun = { ...state.provisionalByRun }
      delete provisionalByRun[active.runId]
      return {
        activeBySession: {
          ...state.activeBySession,
          [sessionId]: { ...active, state: "ready" },
        },
        activeByRun: {
          ...state.activeByRun,
          [active.runId]: { ...active, state: "ready" },
        },
        resourcesByTask: { ...state.resourcesByTask, [active.taskId]: resources },
        provisionalByRun,
      }
    }),
  reconcileRun: (runId, resources) =>
    set((state) => {
      const active = state.activeByRun[runId]
      if (!active) return state
      const provisionalByRun = { ...state.provisionalByRun }
      delete provisionalByRun[runId]
      const activeBySession = { ...state.activeBySession }
      if (activeBySession[active.sessionId]?.runId === runId) {
        activeBySession[active.sessionId] = { ...active, state: "ready" }
      }
      return {
        activeBySession,
        activeByRun: {
          ...state.activeByRun,
          [runId]: { ...active, state: "ready" },
        },
        resourcesByTask: { ...state.resourcesByTask, [active.taskId]: resources },
        provisionalByRun,
      }
    }),
  ingestEvent: (event) =>
    set((state) => {
      const previous = state.provisionalByRun[event.runId]
      if (previous && previous.revision >= event.revision) return state
      return {
        provisionalByRun: { ...state.provisionalByRun, [event.runId]: event },
      }
    }),
  clear: () =>
    set({ activeBySession: {}, activeByRun: {}, resourcesByTask: {}, provisionalByRun: {} }),
}))
