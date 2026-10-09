// The /pet console's actions on a paired phone or browser (ADR-0219,
// `remote` mode).
//
// The pet lives on the desktop. Every action here is a live `pet_*` RPC to it,
// so the desktop's one controller applies it and awards its XP exactly once;
// nothing is queued for later (a feed replayed an hour late would be priced
// against a cooldown and a balance that no longer exist), and nothing writes
// the local pet tables, which are a read-only mirror the next sync overwrites.
// In particular nothing here emits on the local pet bus: there is no
// controller on this device to hear it.
//
// The snapshot (`pet_get`) supplies what the mirror cannot: whether the
// desktop would accept an action, the cooldowns on its clock, and its
// presentation flags. It is refreshed after every action, and a fresh mirror
// pull of the pet tables is kicked on mount and on retry.

"use client"

import { useCallback, useEffect, useMemo } from "react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"
import type {
  PetConsoleActions,
  PetConsoleChat,
} from "@/components/pet/console/pet-console-actions-context"
import {
  usePetRemoteSnapshot,
  useRemoteActionCooldown,
  type UsePetRemoteSnapshotDeps,
} from "@/hooks/pet/use-pet-remote-snapshot"
import { useRemotePetChat, type UseRemotePetChatDeps } from "@/hooks/pet/use-remote-pet-chat"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import type { PetInteractionKind } from "@/lib/pet/access/limits"
import { petConsoleCapability } from "@/lib/pet/console/action-capabilities"
import {
  PET_ACTION_OK,
  PET_DESKTOP_ONLY,
  PET_REMOTE_UNREACHABLE,
  petActionFailed,
  petRemoteRefusalMessage,
  type PetActionOutcome,
} from "@/lib/pet/console/outcome-messages"
import { petItemTitle } from "@/lib/pet/plugin-display"
import type { PetRemoteClient } from "@/lib/pet/remote/client"
import { livePetRemoteClient } from "@/lib/pet/remote/live-transport"
import { PET_MIRROR_TABLES } from "@/lib/pet/remote/mirror"
import type { PetChatLocale, PetRemoteRefused } from "@/lib/pet/remote/types"
import { runSyncDown } from "@/lib/sync/companion-sync"
import type { PetShopItem } from "@/types/pet"
import { toastPetFailure, type PetTranslate } from "./pet-item-ops"

export interface UseRemotePetActionsDeps extends UsePetRemoteSnapshotDeps, UseRemotePetChatDeps {
  getClient?: () => PetRemoteClient
  /** Pull a fresh copy of the pet mirror. */
  pullMirror?: () => Promise<unknown>
}

const pullPetMirror = () => runSyncDown({ only: [...PET_MIRROR_TABLES] })

/** The desktop's chat locales; anything else is answered in English. */
export function toPetChatLocale(locale: string): PetChatLocale {
  return locale === "zh-CN" || locale.startsWith("zh") ? "zh-CN" : "en"
}

const desktopOnly = (): Promise<PetActionOutcome> =>
  Promise.resolve(petActionFailed("desktop-only", PET_DESKTOP_ONLY))

export function useRemotePetActions(deps: UseRemotePetActionsDeps = {}): PetConsoleActions {
  const t = useTranslations("pet") as unknown as PetTranslate
  const locale = useLocale()
  const getClient = deps.getClient ?? livePetRemoteClient
  const pullMirror = deps.pullMirror ?? pullPetMirror
  const runtime = useRuntimeSnapshot()
  const snapshotState = usePetRemoteSnapshot(true, deps)
  const { snapshot, fetchedAt, refresh } = snapshotState
  const cooldown = useRemoteActionCooldown(snapshot, fetchedAt, { now: deps.now })
  const chatState = useRemotePetChat({ enabled: true, locale: toPetChatLocale(locale) }, deps)

  // A fresh mirror on arrival: the console paints from the pet tables, and a
  // phone that has not synced since it was paired would otherwise wait for the
  // next background pass.
  useEffect(() => {
    void pullMirror().catch(() => undefined)
  }, [pullMirror])

  const refused = useCallback(
    (result: PetRemoteRefused): PetActionOutcome =>
      toastPetFailure(petActionFailed("refused", petRemoteRefusalMessage(result.refusal)), t),
    [t]
  )
  const unreachable = useCallback(
    (): PetActionOutcome =>
      toastPetFailure(petActionFailed("unreachable", PET_REMOTE_UNREACHABLE), t),
    [t]
  )

  /**
   * Run one RPC. Refreshes the snapshot afterwards whatever the answer: a
   * refusal is often the desktop telling us our picture was stale (a cooldown
   * another device started, a pet switched off).
   */
  const call = useCallback(
    async <R extends { ok: boolean }>(
      run: (client: PetRemoteClient) => Promise<R>,
      onOk: (result: Extract<R, { ok: true }>) => PetActionOutcome
    ): Promise<PetActionOutcome> => {
      let outcome: PetActionOutcome
      try {
        const result = await run(getClient())
        outcome = result.ok
          ? onOk(result as Extract<R, { ok: true }>)
          : refused(result as unknown as PetRemoteRefused)
      } catch {
        return unreachable()
      }
      void refresh()
      return outcome
    },
    [getClient, refresh, refused, unreachable]
  )

  const itemTitle = useCallback(
    (item: PetShopItem) => petItemTitle(item, locale, (key) => t(key)),
    [locale, t]
  )

  const care = useCallback(
    (kind: PetInteractionKind, extra: { itemId?: string; item?: PetShopItem } = {}) =>
      call(
        (client) => client.act(kind, extra.itemId ? { itemId: extra.itemId } : {}),
        (result) => {
          if (extra.item) {
            toast.success(t("outcomes.use.success", { item: itemTitle(extra.item) }))
          } else if (result.grantedXp > 0 || result.grantedCoins > 0) {
            // The desktop shows the pet's reaction; the phone only sees this.
            toast.success(
              t("console.remote.careRewarded", {
                xp: result.grantedXp,
                coins: result.grantedCoins,
              })
            )
          } else {
            toast.success(t("console.remote.careDone"))
          }
          return PET_ACTION_OK
        }
      ),
    [call, itemTitle, t]
  )

  const applyDecor = useCallback(
    (item: PetShopItem) =>
      call(
        (client) => client.applyDecor(item.id),
        () => {
          toast.success(t("outcomes.apply.success", { item: itemTitle(item) }))
          return PET_ACTION_OK
        }
      ),
    [call, itemTitle, t]
  )

  const retry = useCallback(async () => {
    await Promise.all([refresh(), pullMirror().catch(() => undefined)])
  }, [pullMirror, refresh])

  const { send: sendChat, clear: clearChat } = chatState
  const chat: PetConsoleChat = useMemo(
    () => ({
      enabled: snapshot?.presentation?.chatEnabled === true,
      turns: chatState.turns,
      pending: chatState.pending,
      inFlight: chatState.inFlight,
      degradeReason: chatState.degradeReason,
      awaitingReply: chatState.awaitingReply,
      send: async (text) => toastPetFailure(await sendChat(text), t),
      // Not toasted: the chat tab shows a failed load in place, with a retry,
      // and the status band already reports the connection. Passed through
      // as is, so its identity is stable and the tab's on-entry load runs once.
      refresh: chatState.refresh,
      clear: async () => {
        const outcome = await clearChat()
        if (outcome.ok) toast.success(t("console.chat.cleared"))
        return toastPetFailure(outcome, t)
      },
      enable: desktopOnly,
    }),
    [
      snapshot,
      chatState.turns,
      chatState.pending,
      chatState.inFlight,
      chatState.degradeReason,
      chatState.awaitingReply,
      chatState.refresh,
      sendChat,
      clearChat,
      t,
    ]
  )

  return {
    mode: "remote",
    capability: (id) => petConsoleCapability("remote", id),
    care: (kind) => care(kind),
    purchase: (item) =>
      call(
        (client) => client.purchase(item.id, 1),
        () => {
          toast.success(t("outcomes.purchase.success", { item: itemTitle(item) }))
          return PET_ACTION_OK
        }
      ),
    useItem: (item) => {
      if (!item.consumable) return applyDecor(item)
      // A consumable is spent by the desktop's gate as part of its care
      // action, so the spend and the effect cannot come apart.
      if (!item.interactionKind) {
        return Promise.resolve(
          toastPetFailure(petActionFailed("refused", { key: "outcomes.remote.notDecor" }), t)
        )
      }
      return care(item.interactionKind, { itemId: item.id, item })
    },
    applyDecor,
    rename: (name) =>
      call(
        (client) => client.rename(name),
        () => PET_ACTION_OK
      ),
    hatch: () =>
      call(
        (client) => client.hatch(),
        (result) => {
          if (result.state === "pending") {
            toast.info(t("console.remote.hatchPending"))
            return { ok: true, pending: true }
          }
          return PET_ACTION_OK
        }
      ),
    toggleDesktop: desktopOnly,
    desktop: { visible: snapshot?.presentation?.desktopVisible === true, pending: false },
    cooldownRemaining: cooldown.remaining,
    chat,
    remote: {
      snapshot,
      fetchedAt,
      error: snapshotState.error,
      connection: runtime.connectionState,
      retry,
    },
  }
}
