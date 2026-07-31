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
}

interface TaskWorkspaceStore {
  activeBySession: Record<string, ActiveTaskRun>
  activeByRun: Record<string, ActiveTaskRun>
  resourcesByTask: Record<string, ResourceChange[]>
  provisionalByRun: Record<string, TaskWorkspaceResourceEvent>
  activate: (run: ActiveTaskRun) => void
  bindTrace: (sessionId: string, traceId: string, traceSpanId: string) => void
  reconcile: (sessionId: string, resources: ResourceChange[]) => void
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
