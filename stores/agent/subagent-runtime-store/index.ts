"use client"

/**
 * subagent-runtime-store — Phase 6 of the ClaudeCode 完整化 plan.
 *
 * Two slices in one Zustand store:
 *
 *  - `subAgentTemplates` — persisted to localStorage. Seed = the eight
 *    `BUILT_IN_SUBAGENT_TEMPLATES` from `types/agent/sub-agent.ts`. Users
 *    fork built-ins (which mints a new id with `isBuiltIn: false`) or
 *    create from scratch. Built-ins are read-only — `updateTemplate` and
 *    `deleteTemplate` refuse on `isBuiltIn: true`.
 *
 *  - `subAgents` — ephemeral runtime registry of currently-executing
 *    SubAgents. Producers (the Rust orchestrator wired in a future phase)
 *    push events through `upsert` / `setStatus` / `setProgress` /
 *    `appendLog`. Consumers (the chat-side `SubagentPart` renderer in
 *    Phase 8 + the Settings Runtime tab) subscribe to read.
 *
 * Note: until a producer is wired, the runtime slice is permanently empty
 * and the Settings Runtime tab shows its "no running subagents" empty
 * state. That's an intentional handoff point, not a bug.
 */

import { create } from "zustand"
import { persist, createJSONStorage } from "zustand/middleware"
import {
  BUILT_IN_SUBAGENT_TEMPLATES,
  type SubAgent,
  type SubAgentLog,
  type SubAgentStatus,
  type SubAgentTemplate,
} from "@/types/agent/sub-agent"

interface TemplatesSlice {
  templates: Record<string, SubAgentTemplate>
  addTemplate: (t: SubAgentTemplate) => void
  updateTemplate: (id: string, patch: Partial<SubAgentTemplate>) => void
  deleteTemplate: (id: string) => void
}

interface RuntimeSlice {
  subAgents: Record<string, SubAgent>
  upsert: (subAgent: SubAgent) => void
  setStatus: (id: string, status: SubAgentStatus) => void
  setProgress: (id: string, progress: number) => void
  appendLog: (id: string, log: SubAgentLog) => void
  remove: (id: string) => void
  clearRuntime: () => void
}

export type SubagentRuntimeState = TemplatesSlice & RuntimeSlice

/** Seed = built-in templates keyed by id. */
function seedTemplates(): Record<string, SubAgentTemplate> {
  const out: Record<string, SubAgentTemplate> = {}
  for (const t of BUILT_IN_SUBAGENT_TEMPLATES) out[t.id] = t
  return out
}

export const useSubagentRuntimeStore = create<SubagentRuntimeState>()(
  persist(
    (set) => ({
      // ---- Templates --------------------------------------------------
      templates: seedTemplates(),
      addTemplate: (t) =>
        set((s) => ({
          templates: { ...s.templates, [t.id]: t },
        })),
      updateTemplate: (id, patch) =>
        set((s) => {
          const existing = s.templates[id]
          if (!existing || existing.isBuiltIn) return s
          return { templates: { ...s.templates, [id]: { ...existing, ...patch } } }
        }),
      deleteTemplate: (id) =>
        set((s) => {
          const existing = s.templates[id]
          if (!existing || existing.isBuiltIn) return s
          const next = { ...s.templates }
          delete next[id]
          return { templates: next }
        }),

      // ---- Runtime (ephemeral) ----------------------------------------
      subAgents: {},
      upsert: (subAgent) =>
        set((s) => ({ subAgents: { ...s.subAgents, [subAgent.id]: subAgent } })),
      setStatus: (id, status) =>
        set((s) => {
          const sa = s.subAgents[id]
          if (!sa) return s
          const completedAt =
            status === "completed" || status === "failed" || status === "cancelled"
              ? new Date()
              : sa.completedAt
          return { subAgents: { ...s.subAgents, [id]: { ...sa, status, completedAt } } }
        }),
      setProgress: (id, progress) =>
        set((s) => {
          const sa = s.subAgents[id]
          if (!sa) return s
          const clamped = Math.max(0, Math.min(100, progress))
          return { subAgents: { ...s.subAgents, [id]: { ...sa, progress: clamped } } }
        }),
      appendLog: (id, log) =>
        set((s) => {
          const sa = s.subAgents[id]
          if (!sa) return s
          return {
            subAgents: {
              ...s.subAgents,
              [id]: { ...sa, logs: [...sa.logs, log] },
            },
          }
        }),
      remove: (id) =>
        set((s) => {
          if (!s.subAgents[id]) return s
          const next = { ...s.subAgents }
          delete next[id]
          return { subAgents: next }
        }),
      clearRuntime: () => set({ subAgents: {} }),
    }),
    {
      name: "cognia.subagent-runtime",
      storage: createJSONStorage(() => {
        if (typeof window === "undefined") {
          return {
            getItem: () => null,
            setItem: () => undefined,
            removeItem: () => undefined,
          }
        }
        return window.localStorage
      }),
      // Only persist templates; runtime data is ephemeral by design.
      partialize: (state) => ({ templates: state.templates }) as Partial<SubagentRuntimeState>,
      // On rehydrate, re-seed any missing built-ins so a contributor
      // upgrading mid-version still gets fresh templates.
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as Partial<SubagentRuntimeState>) }
        for (const t of BUILT_IN_SUBAGENT_TEMPLATES) {
          if (!merged.templates[t.id]) merged.templates = { ...merged.templates, [t.id]: t }
        }
        return merged
      },
    }
  )
)
