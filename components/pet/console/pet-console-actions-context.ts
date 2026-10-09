// The /pet console's actions, as one object every tab reads (ADR-0219).
//
// The console runs in two modes. `local`, in the desktop app's main window,
// drives the pet controller directly. `remote`, on a paired phone or browser,
// reads a mirror of the desktop's pet tables and sends every action to the
// desktop over a `pet_*` RPC, so the desktop's one controller awards it once.
// The tabs do not know which: they call these methods, and
// `PetConsoleActionsProvider` decides what each one runs.
//
// Every method resolves to a `PetActionOutcome` and never throws. The mode's
// implementation has already told the user (a toast) by the time it resolves;
// callers branch on the value only for their own state (a pending spinner).
//
// Lives apart from the provider so hooks shared with surfaces outside the
// console (the popup's inventory strip) can ask for the actions without
// importing both implementations.

"use client"

import { createContext, useContext } from "react"
import type { PetInteractionKind } from "@/lib/pet/access/limits"
import type { PetChatDegradeReason } from "@/lib/pet/chat/respond"
import type {
  PetConsoleCapability,
  PetConsoleCapabilityId,
  PetConsoleMode,
} from "@/lib/pet/console/action-capabilities"
import type { PetActionOutcome } from "@/lib/pet/console/outcome-messages"
import type { PetRemoteSnapshot } from "@/lib/pet/remote/types"
import type { RuntimeConnectionState } from "@/lib/runtime/operation-availability"
import type { PetConversationRow, PetShopItem } from "@/types/pet"
import type { PetRemoteSnapshotFailure } from "@/hooks/pet/use-pet-remote-snapshot"

export interface PetConsoleChat {
  /** A turn can produce a real reply (pet chat is switched on). */
  enabled: boolean
  /** Undefined while the transcript loads. */
  turns: PetConversationRow[] | undefined
  pending: string | null
  inFlight: boolean
  degradeReason: PetChatDegradeReason | null
  /** The desktop is still producing the reply to `pending` (remote only). */
  awaitingReply: boolean
  send: (text: string) => Promise<PetActionOutcome>
  /** Re-read the transcript. A live query keeps the local one current already. */
  refresh: () => Promise<PetActionOutcome>
  clear: () => Promise<PetActionOutcome>
  /** Switch pet chat on. Desktop-only: it is a desktop setting. */
  enable: () => Promise<PetActionOutcome>
}

/** What the remote console knows about the desktop it is caring through. */
export interface PetConsoleRemote {
  /** Undefined until the desktop first answers `pet_get`. */
  snapshot: PetRemoteSnapshot | undefined
  /** This device's clock when `snapshot` arrived. */
  fetchedAt: number | null
  error: PetRemoteSnapshotFailure | null
  connection: RuntimeConnectionState
  /** Ask the desktop again and pull a fresh copy of the pet mirror. */
  retry: () => Promise<void>
}

export interface PetConsoleActions {
  mode: PetConsoleMode
  /** Whether a capability runs in this mode (see `action-capabilities.ts`). */
  capability: (id: PetConsoleCapabilityId) => PetConsoleCapability
  /**
   * A care action. `text` rides along with `talked` on the desktop (LLM
   * speak); a remote talk is the plain care action, and words go through chat.
   */
  care: (kind: PetInteractionKind, opts?: { text?: string }) => Promise<PetActionOutcome>
  purchase: (item: PetShopItem) => Promise<PetActionOutcome>
  /** Use an owned item: a consumable's care action, or a decor item's look. */
  useItem: (item: PetShopItem) => Promise<PetActionOutcome>
  applyDecor: (item: PetShopItem) => Promise<PetActionOutcome>
  rename: (name: string) => Promise<PetActionOutcome>
  hatch: () => Promise<PetActionOutcome>
  /** Send the pet out to the desktop, or call it back. Desktop-only. */
  toggleDesktop: () => Promise<PetActionOutcome>
  /** Whether the desktop overlay pet is out, and whether a toggle is running. */
  desktop: { visible: boolean; pending: boolean }
  /**
   * Remaining cooldown per care kind, when the mode owns it. The local console
   * leaves it unset: the action grid reads the controller's own gate.
   */
  cooldownRemaining?: (kind: string) => number
  chat: PetConsoleChat
  /** Null in local mode. */
  remote: PetConsoleRemote | null
}

export const PetConsoleActionsContext = createContext<PetConsoleActions | null>(null)

/** The console's actions. Only valid under `PetConsoleActionsProvider`. */
export function usePetConsoleActions(): PetConsoleActions {
  const actions = useContext(PetConsoleActionsContext)
  if (!actions) {
    throw new Error("usePetConsoleActions must be used inside PetConsoleActionsProvider")
  }
  return actions
}

/**
 * The console's actions when rendered inside it, else null. For pieces shared
 * with surfaces outside the console, which then fall back to the local pet.
 */
export function useOptionalPetConsoleActions(): PetConsoleActions | null {
  return useContext(PetConsoleActionsContext)
}
