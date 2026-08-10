"use client"

import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react"

import type { AgentExecutionHandle } from "@/lib/ai/agent/execution/agent-execution-handle"

export interface AgentExecutionHandleDirectory {
  get(sessionId: string): AgentExecutionHandle | undefined
  register(handle: AgentExecutionHandle): void
  unregister(sessionId: string, expectedHandle?: AgentExecutionHandle): void
  subscribe(listener: () => void): () => void
}

function createDirectory(): AgentExecutionHandleDirectory {
  const handles = new Map<string, AgentExecutionHandle>()
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())

  return {
    get: (sessionId) => handles.get(sessionId),
    register: (handle) => {
      if (handles.get(handle.sessionId) === handle) return
      handles.set(handle.sessionId, handle)
      notify()
    },
    unregister: (sessionId, expectedHandle) => {
      if (expectedHandle && handles.get(sessionId) !== expectedHandle) return
      if (!handles.delete(sessionId)) return
      notify()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const fallbackDirectory: AgentExecutionHandleDirectory = {
  get: () => undefined,
  register: () => undefined,
  unregister: () => undefined,
  subscribe: () => () => undefined,
}
const AgentExecutionHandleContext = createContext<AgentExecutionHandleDirectory>(fallbackDirectory)

export function AgentExecutionHandleProvider({ children }: { children: ReactNode }) {
  const [directory] = useState(createDirectory)
  return (
    <AgentExecutionHandleContext.Provider value={directory}>
      {children}
    </AgentExecutionHandleContext.Provider>
  )
}

export function useAgentExecutionHandleDirectory(): AgentExecutionHandleDirectory {
  return useContext(AgentExecutionHandleContext)
}

export function useAgentExecutionHandle(
  sessionId: string | null | undefined
): AgentExecutionHandle | undefined {
  const directory = useAgentExecutionHandleDirectory()
  return useSyncExternalStore(
    directory.subscribe,
    () => (sessionId ? directory.get(sessionId) : undefined),
    () => undefined
  )
}
