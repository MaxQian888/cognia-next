// Quick-use strip for owned consumables: one button per owned catalog
// consumable (icon + qty badge); clicking uses it via the shop's `consumeItem`
// (decrement + interaction event with `meta.itemId`, controller owns the
// restore/XP). Inventory is read reactively. Renders nothing when the user
// owns no consumables — and must NOT be mounted in the popup window, which has
// no pet controller to process the consume event.

"use client"

import { useLocale, useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { listPetInventory } from "@/lib/db/pet"
import { listAllPetItems } from "@/lib/pet/economy/item-catalog"
import { isPluginPetId, pluginItemText } from "@/lib/pet/plugin-display"
import { consumeItem } from "@/lib/pet/economy/shop"
import { petItemIcon } from "./item-icons"

export interface PetInventoryStripProps {
  className?: string
}

export function PetInventoryStrip({ className }: PetInventoryStripProps) {
  const t = useTranslations("pet")
  const locale = useLocale()
  const inventory = useLiveQuery(() => listPetInventory(), [])
  const ownedQty = new Map((inventory ?? []).map((row) => [row.id, row.qty]))
  // Full catalog (static + plugin): a plugin consumable the user owns must
  // stay usable from the strip, not silently vanish from the quick-use row.
  const owned = listAllPetItems().filter((i) => i.consumable && (ownedQty.get(i.id) ?? 0) > 0)
  if (owned.length === 0) return null

  return (
    <div
      data-testid="pet-inventory-strip"
      className={cn("flex flex-col gap-1.5 rounded-lg border p-2.5", className)}
    >
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {t("inventory.title")}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {owned.map((item) => {
          const Icon = petItemIcon(item.icon)
          const qty = ownedQty.get(item.id) ?? 0
          const pluginText = isPluginPetId(item.id) ? pluginItemText(item.id, locale) : undefined
          const label = pluginText?.title ?? t(`shop.items.${item.i18nKey}.title`)
          const description = pluginText
            ? (pluginText.description ?? pluginText.title)
            : t(`shop.items.${item.i18nKey}.description`)
          return (
            <Button
              key={item.id}
              size="sm"
              variant="secondary"
              data-action={`use-${item.id}`}
              aria-label={label}
              title={description}
              className="h-8 gap-1 px-2"
              onClick={() => void consumeItem(item.id)}
            >
              <Icon className="size-4" />
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {t("shop.owned", { qty })}
              </span>
            </Button>
          )
        })}
      </div>
    </div>
  )
}
