"use client"

/**
 * Agent runtime selector — picks which engine drives the next chat turn.
 *
 * cognia-next ships with a Claude SDK sidecar as the default agent runtime.
 * The migrated External Agent layer adds a peer runtime that spawns a CLI
 * process (Codex, Claude Code CLI, Gemini CLI, Cursor, custom) over stdio.
 * The Agent Mode layer is a *prompt modifier* that overlays a system
 * prompt + tool list onto whichever runtime is active.
 *
 * This tiny store is the glue between the chat composer and the rest:
 *   - `runtime`: which engine to dispatch to (claude-sdk | external)
 *   - `modeId`: which built-in or custom mode is selected (default "general")
 *   - `externalAgentId`: the active External Agent record id when runtime is `external`
 *
 * Persisted to localStorage so the user's last choice survives reload.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"

export type AgentRuntime = "claude-sdk" | "external"

interface AgentRuntimeState {
  runtime: AgentRuntime
  modeId: string
  externalAgentId: string | null

  setRuntime: (runtime: AgentRuntime) => void
  setModeId: (modeId: string) => void
  setExternalAgentId: (id: string | null) => void
}

export const useAgentRuntimeStore = create<AgentRuntimeState>()(
  persist(
    (set) => ({
      runtime: "claude-sdk",
      modeId: "general",
      externalAgentId: null,

      setRuntime: (runtime) => set({ runtime }),
      setModeId: (modeId) => set({ modeId }),
      setExternalAgentId: (externalAgentId) => set({ externalAgentId }),
    }),
    {
      name: "cognia-next.agent-runtime",
      version: 1,
    }
  )
)
