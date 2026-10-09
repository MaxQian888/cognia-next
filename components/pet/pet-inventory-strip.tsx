// Quick-use strip for owned consumables: one button per owned catalog
// consumable (icon + qty badge); clicking uses it via the shop's `consumeItem`
// (decrement + interaction event with `meta.itemId`, controller owns the
// restore/XP), through `usePetItemActions` so a refused use (cooling down)
// says so instead of doing nothing. Inventory is read reactively. Renders
// nothing when the user owns no consumables — and must NOT be mounted in the
// popup window, which has no pet controller to process the consume event.

"use client"

import { useLocale, useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { listPetInventory } from "@/lib/db/pet"
import { isPluginPetId, pluginItemText } from "@/lib/pet/plugin-display"
import { usePetItemCatalog } from "@/hooks/pet/use-pet-item-catalog"
import { usePetItemActions } from "@/hooks/pet/use-pet-item-actions"
import { petItemIcon } from "./item-icons"

export interface PetInventoryStripProps {
  className?: string
  variant?: "outlined" | "flat"
  /** `comfortable` gives each item a 44px touch target (the full console). */
  size?: "compact" | "comfortable"
}

export function PetInventoryStrip({
  className,
  variant = "outlined",
  size = "compact",
}: PetInventoryStripProps) {
  const t = useTranslations("pet")
  const locale = useLocale()
  const inventory = useLiveQuery(() => listPetInventory(), [])
  const catalog = usePetItemCatalog()
  const actions = usePetItemActions()
  const ownedQty = new Map((inventory ?? []).map((row) => [row.id, row.qty]))
  // Full catalog (static + plugin): a plugin consumable the user owns must
  // stay usable from the strip, not silently vanish from the quick-use row.
  const owned = catalog.filter((i) => i.consumable && (ownedQty.get(i.id) ?? 0) > 0)
  if (owned.length === 0) return null

  return (
    <div
      data-testid="pet-inventory-strip"
      data-variant={variant}
      className={cn(
        "flex flex-col gap-1.5",
        variant === "outlined" && "rounded-lg border p-2.5",
        className
      )}
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
              disabled={actions.isPending("use", item.id)}
              className={cn("gap-1 px-2", size === "comfortable" ? "h-11 px-3" : "h-8")}
              onClick={() => void actions.use(item)}
            >
              <Icon className="size-4" />
              <span
                className={cn(
                  "tabular-nums text-muted-foreground",
                  size === "comfortable" ? "text-xs" : "text-[10px]"
                )}
              >
                {t("shop.owned", { qty })}
              </span>
            </Button>
          )
        })}
      </div>
    </div>
  )
}
