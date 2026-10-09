// Chooses what the /pet console's actions run (ADR-0219).
//
// `local`: the desktop app's main window, driving its own pet controller
// (`useLocalPetActions`). `remote`: a paired phone or browser, sending every
// action to the desktop over `pet_*` RPCs (`useRemotePetActions`). The two
// implementations are separate components, so a mode change remounts the
// provider instead of swapping hooks under a live component, and the remote
// tree never so much as subscribes to the local chat or shop paths.
//
// The tabs read the result with `usePetConsoleActions()` (from
// `pet-console-actions-context.ts`, re-exported here).

"use client"

import type { ReactNode } from "react"
import type { UsePetResult } from "@/hooks/pet/use-pet"
import { useLocalPetActions } from "@/hooks/pet/use-local-pet-actions"
import { useRemotePetActions } from "@/hooks/pet/use-remote-pet-actions"
import type { PetConsoleMode } from "@/lib/pet/console/action-capabilities"
import { PetConsoleActionsContext } from "./pet-console-actions-context"

export {
  usePetConsoleActions,
  useOptionalPetConsoleActions,
  type PetConsoleActions,
  type PetConsoleChat,
  type PetConsoleRemote,
} from "./pet-console-actions-context"

export interface PetConsoleActionsProviderProps {
  mode: PetConsoleMode
  /** The pet as this device reads it: its own store, or the mirror. */
  pet: UsePetResult
  activeCharacterId: string | null | undefined
  children: ReactNode
}

function LocalPetConsoleActions({
  pet,
  activeCharacterId,
  children,
}: Omit<PetConsoleActionsProviderProps, "mode">) {
  const actions = useLocalPetActions({ pet, activeCharacterId })
  return (
    <PetConsoleActionsContext.Provider value={actions}>
      {children}
    </PetConsoleActionsContext.Provider>
  )
}

function RemotePetConsoleActions({ children }: { children: ReactNode }) {
  const actions = useRemotePetActions()
  return (
    <PetConsoleActionsContext.Provider value={actions}>
      {children}
    </PetConsoleActionsContext.Provider>
  )
}

export function PetConsoleActionsProvider({
  mode,
  pet,
  activeCharacterId,
  children,
}: PetConsoleActionsProviderProps) {
  return mode === "remote" ? (
    <RemotePetConsoleActions>{children}</RemotePetConsoleActions>
  ) : (
    <LocalPetConsoleActions pet={pet} activeCharacterId={activeCharacterId}>
      {children}
    </LocalPetConsoleActions>
  )
}
