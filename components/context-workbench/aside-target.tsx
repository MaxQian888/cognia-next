"use client"

/**
 * Which conversation a workbench sidechat is an aside *to*.
 *
 * Only the session-bound sidechat provides this. The other workbench chats are
 * bound to an artifact / canvas / project file, and "hand this back to the main
 * thread" has no meaning there — there is no main thread, just a document.
 *
 * A context rather than a prop because the consumer is the message action bar,
 * which sits many levels below the panel inside a virtualized list. Reading a
 * context costs nothing per row; a Dexie lookup per message would not be.
 */

import { createContext, useContext, type ReactNode } from "react"

const AsideTargetContext = createContext<string | null>(null)

export function AsideTargetProvider({
  sessionId,
  children,
}: {
  /** The MAIN conversation this aside belongs to. */
  sessionId: string
  children: ReactNode
}) {
  return <AsideTargetContext.Provider value={sessionId}>{children}</AsideTargetContext.Provider>
}

/** The main conversation to hand content back to, or `null` outside an aside. */
export function useAsideTarget(): string | null {
  return useContext(AsideTargetContext)
}
