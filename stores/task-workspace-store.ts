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
}

interface TaskWorkspaceStore {
  activeBySession: Record<string, ActiveTaskRun>
  resourcesByTask: Record<string, ResourceChange[]>
  provisionalByRun: Record<string, TaskWorkspaceResourceEvent>
  activate: (run: ActiveTaskRun) => void
  reconcile: (sessionId: string, resources: ResourceChange[]) => void
  ingestEvent: (event: TaskWorkspaceResourceEvent) => void
  clear: () => void
}

export const useTaskWorkspaceStore = create<TaskWorkspaceStore>((set) => ({
  activeBySession: {},
  resourcesByTask: {},
  provisionalByRun: {},
  activate: (run) =>
    set((state) => ({
      activeBySession: { ...state.activeBySession, [run.sessionId]: run },
    })),
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
  clear: () => set({ activeBySession: {}, resourcesByTask: {}, provisionalByRun: {} }),
}))
