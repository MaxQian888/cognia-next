"use client"

import { createContext, useContext, type ReactNode } from "react"

export interface ChatScopeValue {
  sessionId: string
}

const ChatScopeContext = createContext<ChatScopeValue | null>(null)

export function ChatScopeProvider({
  sessionId,
  children,
}: {
  sessionId: string
  children: ReactNode
}) {
  return <ChatScopeContext.Provider value={{ sessionId }}>{children}</ChatScopeContext.Provider>
}

export function useOptionalChatScope(): ChatScopeValue | null {
  return useContext(ChatScopeContext)
}

export function useChatScope(): ChatScopeValue {
  const scope = useOptionalChatScope()
  if (!scope) throw new Error("useChatScope must be used inside ChatScopeProvider")
  return scope
}
