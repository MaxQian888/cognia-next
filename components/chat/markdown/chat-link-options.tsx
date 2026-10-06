"use client"

/**
 * The resolved `messageDisplay.links` options for the markdown below
 * (ADR-0218).
 *
 * `ChatLink` is reached through memoised component maps in two markdown
 * pipelines, so threading the options as props would rebuild those maps on
 * every settings change. `MessageShell` provides them once per message; any
 * surface without a provider (a plugin README, a skill doc) reads the
 * defaults, which is how links looked there before the setting existed.
 */

import { createContext, useContext, type ReactNode } from "react"
import { DEFAULT_MESSAGE_LINK_OPTIONS } from "@/lib/chat/message-display"
import type { MessageLinkOptions } from "@/types/appearance"

const ChatLinkOptionsContext = createContext<MessageLinkOptions>(DEFAULT_MESSAGE_LINK_OPTIONS)

export function ChatLinkOptionsProvider({
  value,
  children,
}: {
  value: MessageLinkOptions
  children: ReactNode
}) {
  return <ChatLinkOptionsContext.Provider value={value}>{children}</ChatLinkOptionsContext.Provider>
}

export function useChatLinkOptions(): MessageLinkOptions {
  return useContext(ChatLinkOptionsContext)
}
