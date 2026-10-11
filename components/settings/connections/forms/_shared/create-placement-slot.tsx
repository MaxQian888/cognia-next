"use client"

/**
 * Where a new connection runs (ADR-0224 A5 step 7), handed to whichever
 * platform dialog is creating one.
 *
 * Twelve dialogs create connections and none of them should know about
 * always-on hosts, so the choice travels by context: `AdapterConfigDialog`
 * provides it while creating, `AdapterFormSections` (and the plugin dialog,
 * which has its own layout) draws it at the top. Editing provides nothing,
 * and neither does any other form that reuses the section shell.
 */

import { createContext, useContext, type ReactNode } from "react"

const CreatePlacementSlot = createContext<ReactNode>(null)

export function CreatePlacementProvider({
  slot,
  children,
}: {
  slot: ReactNode
  children: ReactNode
}) {
  return <CreatePlacementSlot.Provider value={slot}>{children}</CreatePlacementSlot.Provider>
}

/** The choice to draw above a create form, or null when there is none. */
export function useCreatePlacementSlot(): ReactNode {
  return useContext(CreatePlacementSlot)
}
