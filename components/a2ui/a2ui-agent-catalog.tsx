"use client"

/**
 * The A2UI catalog of the agent whose output is being rendered.
 *
 * A surface can name its own catalog; when it does not, it renders with the
 * producing agent's `Character.a2uiCatalogId` before the app-level default
 * (see `resolveA2UICatalogId`). Chat provides this per message, so a team
 * room renders each member's surfaces with that member's catalog. Surfaces
 * outside chat have no provider and keep the app default.
 */

import { createContext, useContext, type ReactNode } from "react"

const A2UIAgentCatalogContext = createContext<string | undefined>(undefined)

export function A2UIAgentCatalogProvider({
  catalogId,
  children,
}: {
  catalogId: string | undefined
  children: ReactNode
}) {
  return (
    <A2UIAgentCatalogContext.Provider value={catalogId}>
      {children}
    </A2UIAgentCatalogContext.Provider>
  )
}

/** The enclosing agent's catalog id, or `undefined` outside an agent's output. */
export function useA2UIAgentCatalogId(): string | undefined {
  return useContext(A2UIAgentCatalogContext)
}
