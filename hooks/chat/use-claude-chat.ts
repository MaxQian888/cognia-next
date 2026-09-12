"use client"

import { createContext, createElement, useContext, type ReactNode } from "react"
import { useClaudeChat as useClaudeChatController } from "./use-claude-chat-controller"

export { shouldGenerateTitle } from "@/lib/ai/generation/run-title-task"

type ClaudeChatRuntime = ReturnType<typeof useClaudeChatController>
const ClaudeChatRuntimeContext = createContext<ClaudeChatRuntime | null>(null)

/** One application-owned controller survives pane navigation and retained surfaces. */
export function ClaudeChatRuntimeProvider({ children }: { children: ReactNode }) {
  const parent = useContext(ClaudeChatRuntimeContext)
  if (parent) {
    throw new Error("ClaudeChatRuntimeProvider must be mounted once at application bootstrap")
  }
  return createElement(ClaudeChatRuntimeOwner, null, children)
}

function ClaudeChatRuntimeOwner({ children }: { children: ReactNode }) {
  const runtime = useClaudeChatController()
  return createElement(ClaudeChatRuntimeContext.Provider, { value: runtime }, children)
}

/** Every surface shares the same commands, streaming mirror and event queue. */
export function useClaudeChat(): ClaudeChatRuntime {
  const runtime = useOptionalClaudeChat()
  if (!runtime) {
    throw new Error("useClaudeChat requires ClaudeChatRuntimeProvider")
  }
  return runtime
}

/**
 * The runtime if one is mounted, otherwise null.
 *
 * For surfaces that are CONSTRUCTED outside the provider but only ever SEND
 * inside it — the artifacts dock body renders in the app (provider present),
 * in Storybook and in unit tests (no provider), and a hook that throws on
 * construction would make the panel unrenderable in the latter two. Callers
 * must still refuse to send when this returns null rather than pretending the
 * message went out.
 */
export function useOptionalClaudeChat(): ClaudeChatRuntime | null {
  return useContext(ClaudeChatRuntimeContext)
}
