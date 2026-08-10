"use client"

import { createContext, useContext, type ReactNode } from "react"

export interface ChatScopeValue {
  sessionId: string
  compact?: () => Promise<void>
  setModel?: (model: string) => Promise<void>
  resetRuntime?: () => Promise<void>
}

const ChatScopeContext = createContext<ChatScopeValue | null>(null)

export function ChatScopeProvider({
  sessionId,
  compact,
  setModel,
  resetRuntime,
  children,
}: {
  sessionId: string
  compact?: () => Promise<void>
  setModel?: (model: string) => Promise<void>
  resetRuntime?: () => Promise<void>
  children: ReactNode
}) {
  return (
    <ChatScopeContext.Provider value={{ sessionId, compact, setModel, resetRuntime }}>
      {children}
    </ChatScopeContext.Provider>
  )
}

export function useOptionalChatScope(): ChatScopeValue | null {
  return useContext(ChatScopeContext)
}

export function useChatScope(): ChatScopeValue {
  const scope = useOptionalChatScope()
  if (!scope) throw new Error("useChatScope must be used inside ChatScopeProvider")
  return scope
}
