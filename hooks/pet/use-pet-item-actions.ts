// Buy and use pet items with feedback.
//
// The shop tab and the nurture tab's quick-use strip both called the shop
// functions with `void` and dropped the `{ ok, error }` they return, so "not
// enough coins", "still chewing" and a failed write all looked like a click
// that did nothing. Both surfaces now go through this hook: one pending flag
// per item and action (no double purchase while a write is in flight), one
// toast per outcome, worded by `lib/pet/console/outcome-messages.ts`.
//
// Inside the /pet console the item actions are the console's own
// (`PetConsoleActions`), so a paired phone buys and uses items on the DESKTOP
// pet (ADR-0219). Outside it (the desktop popup's inventory strip) they are
// this device's shop, as before.

"use client"

import { useMemo, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { useOptionalPetConsoleActions } from "@/components/pet/console/pet-console-actions-context"
import { createLocalPetItemOps, type PetTranslate } from "@/hooks/pet/pet-item-ops"
import type { PetActionOutcome } from "@/lib/pet/console/outcome-messages"
import { petItemTitle } from "@/lib/pet/plugin-display"
import type { PetShopItem } from "@/types/pet"

export type PetItemActionKind = "buy" | "use"

export interface PetItemActions {
  purchase: (item: PetShopItem) => Promise<PetActionOutcome>
  use: (item: PetShopItem) => Promise<PetActionOutcome>
  /** True while this action on this item is still running. */
  isPending: (kind: PetItemActionKind, itemId: string) => boolean
  /** The item's display name in the current locale (plugin items included). */
  itemTitle: (item: PetShopItem) => string
}

export function usePetItemActions(): PetItemActions {
  const t = useTranslations("pet") as unknown as PetTranslate
  const locale = useLocale()
  const consoleActions = useOptionalPetConsoleActions()
  const localOps = useMemo(() => createLocalPetItemOps(t, locale), [t, locale])
  const ops = consoleActions ?? localOps
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())

  const key = (kind: PetItemActionKind, itemId: string) => `${kind}:${itemId}`
  const begin = (k: string) => setPending((prev) => new Set(prev).add(k))
  const end = (k: string) =>
    setPending((prev) => {
      const next = new Set(prev)
      next.delete(k)
      return next
    })

  const track = async (
    kind: PetItemActionKind,
    item: PetShopItem,
    run: () => Promise<PetActionOutcome>
  ): Promise<PetActionOutcome> => {
    const k = key(kind, item.id)
    begin(k)
    try {
      return await run()
    } finally {
      end(k)
    }
  }

  return {
    purchase: (item) => track("buy", item, () => ops.purchase(item)),
    use: (item) => track("use", item, () => ops.useItem(item)),
    isPending: (kind, itemId) => pending.has(key(kind, itemId)),
    itemTitle: (item) => petItemTitle(item, locale, (k) => t(k)),
  }
}
