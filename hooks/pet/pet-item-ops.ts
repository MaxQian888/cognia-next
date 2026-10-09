// This device's own pet shop, with a toast per outcome.
//
// Split from the console's local actions (`use-local-pet-actions.ts`) because
// the desktop popup's inventory strip uses it too, outside any console, and
// must not pull the hatch, chat and window-toggle paths into the popup.

"use client"

import { toast } from "sonner"
import {
  PET_ACTION_OK,
  consumeErrorMessage,
  petActionFailed,
  purchaseErrorMessage,
  type PetActionOutcome,
} from "@/lib/pet/console/outcome-messages"
import { consumeItem, purchaseItem } from "@/lib/pet/economy/shop"
import { petItemTitle } from "@/lib/pet/plugin-display"
import type { PetShopItem } from "@/types/pet"

/** The console's `pet` translator, as the toasts below need it. */
export type PetTranslate = (key: string, values?: Record<string, string | number>) => string

/** Tell the user why an action did not happen. Successes are each caller's. */
export function toastPetFailure(outcome: PetActionOutcome, t: PetTranslate): PetActionOutcome {
  if (!outcome.ok && outcome.reason !== "desktop-only") {
    toast.error(t(outcome.message.key, outcome.message.values))
  }
  return outcome
}

export interface PetItemOps {
  purchase: (item: PetShopItem) => Promise<PetActionOutcome>
  useItem: (item: PetShopItem) => Promise<PetActionOutcome>
  applyDecor: (item: PetShopItem) => Promise<PetActionOutcome>
}

/**
 * Buy and use items in this device's own shop, with a toast per outcome. The
 * one implementation behind both the console (through the provider) and the
 * popup's inventory strip (which has no console around it).
 */
export function createLocalPetItemOps(t: PetTranslate, locale: string): PetItemOps {
  const title = (item: PetShopItem) => petItemTitle(item, locale, (key) => t(key))

  const use = async (item: PetShopItem): Promise<PetActionOutcome> => {
    try {
      const result = await consumeItem(item.id)
      if (result.ok) {
        toast.success(
          t(item.consumable ? "outcomes.use.success" : "outcomes.apply.success", {
            item: title(item),
          })
        )
        return PET_ACTION_OK
      }
      return toastPetFailure(petActionFailed("refused", consumeErrorMessage(result)), t)
    } catch {
      return toastPetFailure(petActionFailed("failed", { key: "outcomes.failed" }), t)
    }
  }

  return {
    async purchase(item) {
      try {
        const result = await purchaseItem(item.id)
        if (result.ok) {
          toast.success(t("outcomes.purchase.success", { item: title(item) }))
          return PET_ACTION_OK
        }
        return toastPetFailure(petActionFailed("refused", purchaseErrorMessage(result.error)), t)
      } catch {
        return toastPetFailure(petActionFailed("failed", { key: "outcomes.failed" }), t)
      }
    },
    useItem: use,
    // `consumeItem` already applies a decor item's look without spending it.
    applyDecor: use,
  }
}
