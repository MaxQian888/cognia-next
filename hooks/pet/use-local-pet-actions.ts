// The /pet console's actions on the desktop that runs the pet (ADR-0219,
// `local` mode).
//
// These are the functions the console called directly before it learned to
// run remotely, gathered behind `PetConsoleActions` so the same tabs can be
// handed a remote implementation instead. Care actions are user events on the
// pet bus (the controller persists them and answers a refusal with its own
// cooldown bubble); the shop, rename, hatch and chat paths are the same lib
// calls as before, each turned into a `PetActionOutcome` and told to the user
// once, here.

"use client"

import { useMemo, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"
import type { UsePetResult } from "@/hooks/pet/use-pet"
import { usePetChat } from "@/hooks/pet/use-pet-chat"
import type {
  PetConsoleActions,
  PetConsoleChat,
} from "@/components/pet/console/pet-console-actions-context"
import type { PetInteractionKind } from "@/lib/pet/access/limits"
import { petConsoleCapability } from "@/lib/pet/console/action-capabilities"
import {
  PET_ACTION_OK,
  petActionFailed,
  type PetActionOutcome,
} from "@/lib/pet/console/outcome-messages"
import { hatchPetOnce } from "@/lib/pet/runtime/hatch"
import { isValidPetName, renamePet } from "@/lib/pet/runtime/rename-pet"
import { toggleDesktopPetWindow } from "@/lib/pet/commands"
import { updatePetSettings } from "@/lib/pet/settings-sync"
import { clearPetConversation } from "@/lib/db/pet-conversation"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_PET_DESKTOP_OVERLAY, DEFAULT_PET_SETTINGS } from "@/types/pet"
import { createLocalPetItemOps, toastPetFailure, type PetTranslate } from "./pet-item-ops"

/**
 * The local transcript is a live query, current without asking. Module-level
 * so its identity is stable: the chat tab re-reads on a change of `refresh`.
 */
const refreshLiveTranscript = async (): Promise<PetActionOutcome> => PET_ACTION_OK

export interface UseLocalPetActionsInput {
  pet: UsePetResult
  activeCharacterId: string | null | undefined
}

export function useLocalPetActions({
  pet,
  activeCharacterId,
}: UseLocalPetActionsInput): PetConsoleActions {
  const t = useTranslations("pet") as unknown as PetTranslate
  const locale = useLocale()
  const appSettings = useSettingsStore((s) => s.settings)
  const petSettings = appSettings?.petSettings ?? DEFAULT_PET_SETTINGS
  // `desktopPet.enabled` tracks the native window (PetMount syncs every
  // native open/close into it), so the toggle can label itself without
  // probing the window.
  const desktopVisible = (petSettings.desktopPet ?? DEFAULT_PET_DESKTOP_OVERLAY).enabled === true
  const [desktopPending, setDesktopPending] = useState(false)

  const chatState = usePetChat({ profile: pet.profile, view: pet.view, activeCharacterId })
  const items = useMemo(() => createLocalPetItemOps(t, locale), [t, locale])

  const care = async (
    kind: PetInteractionKind,
    opts: { text?: string } = {}
  ): Promise<PetActionOutcome> => {
    try {
      switch (kind) {
        case "fed":
          pet.feed()
          break
        case "played":
          pet.play()
          break
        case "petted":
          pet.petStroke()
          break
        case "talked":
          pet.talk(opts.text)
          break
        case "slept":
          pet.sleep()
          break
        case "cleaned":
          pet.clean()
          break
        case "treated":
          pet.treat()
          break
      }
      // The controller answers a refused care action with its own cooldown
      // bubble on the pet, so there is nothing to toast here.
      return PET_ACTION_OK
    } catch {
      return toastPetFailure(petActionFailed("failed", { key: "outcomes.failed" }), t)
    }
  }

  const chat: PetConsoleChat = {
    enabled: petSettings.llmSpeak?.enabled === true,
    turns: chatState.turns,
    pending: chatState.pending,
    inFlight: chatState.inFlight,
    degradeReason: chatState.degradeReason,
    awaitingReply: false,
    async send(text) {
      try {
        await chatState.send(text)
        return PET_ACTION_OK
      } catch {
        return toastPetFailure(petActionFailed("failed", { key: "outcomes.failed" }), t)
      }
    },
    refresh: refreshLiveTranscript,
    async clear() {
      try {
        await clearPetConversation()
        toast.success(t("console.chat.cleared"))
        return PET_ACTION_OK
      } catch {
        return toastPetFailure(petActionFailed("failed", { key: "console.chat.clearFailed" }), t)
      }
    },
    async enable() {
      // Through the cross-window lock over the persisted record, never a
      // whole-object save of this render's copy: the desktop overlay writes
      // its resting position from its own window, and a stale save reverted it.
      try {
        await updatePetSettings((latest) => ({
          ...latest,
          llmSpeak: { ...latest.llmSpeak, enabled: true },
        }))
        return PET_ACTION_OK
      } catch {
        return toastPetFailure(petActionFailed("failed", { key: "chat.enableCta.failed" }), t)
      }
    },
  }

  return {
    mode: "local",
    capability: (id) => petConsoleCapability("local", id),
    care,
    purchase: items.purchase,
    useItem: items.useItem,
    applyDecor: items.applyDecor,
    async rename(name) {
      // Refused up front rather than inside `renamePet`, whose `undefined` also
      // means "no pet yet" and would otherwise read as a silent success.
      if (!isValidPetName(name)) {
        return toastPetFailure(
          petActionFailed("refused", { key: "outcomes.remote.invalidName" }),
          t
        )
      }
      try {
        await renamePet(name)
        return PET_ACTION_OK
      } catch {
        return toastPetFailure(petActionFailed("failed", { key: "console.renameFailed" }), t)
      }
    },
    async hatch() {
      const outcome = await hatchPetOnce(appSettings)
      switch (outcome.status) {
        case "hatched":
        case "already-hatched":
          return PET_ACTION_OK
        case "no-profile":
          return toastPetFailure(
            petActionFailed("refused", { key: "outcomes.refusal.uninitialized" }),
            t
          )
        case "failed":
          return toastPetFailure(petActionFailed("failed", { key: "console.hatchFailed" }), t)
      }
    },
    async toggleDesktop() {
      setDesktopPending(true)
      try {
        const open = await toggleDesktopPetWindow()
        // `toggleDesktopPetWindow` returns the resulting state and reports a
        // window that would not open as `false`, not as a throw.
        if (!desktopVisible && !open) {
          return toastPetFailure(
            petActionFailed("failed", { key: "console.desktopToggle.openFailed" }),
            t
          )
        }
        return PET_ACTION_OK
      } catch {
        return toastPetFailure(
          petActionFailed("failed", { key: "console.desktopToggle.failed" }),
          t
        )
      } finally {
        setDesktopPending(false)
      }
    },
    desktop: { visible: desktopVisible, pending: desktopPending },
    chat,
    remote: null,
  }
}
