// Shop tab: coin balance + streak header, then the static item catalog grouped
// by category. Buying deducts coins into the inventory; using a consumable
// emits its interaction event (the controller owns the restore/XP), and decor
// applies its cosmetic override. Balance/inventory are read reactively.

"use client"

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { CoinsIcon, FlameIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { getPetProfile, listPetInventory } from "@/lib/db/pet"
import { PET_ITEMS } from "@/lib/pet/economy/item-catalog"
import { canAfford, consumeItem, purchaseItem } from "@/lib/pet/economy/shop"
import { normalizeCoins, normalizeStreak, type PetItemCategory } from "@/types/pet"
import { petItemIcon } from "../item-icons"

const CATEGORIES: PetItemCategory[] = ["food", "toy", "decor"]

export function ShopTab() {
  const t = useTranslations("pet")
  const profile = useLiveQuery(() => getPetProfile(), [])
  const inventory = useLiveQuery(() => listPetInventory(), [])

  const coins = normalizeCoins(profile?.coins)
  const streak = normalizeStreak(profile?.streak)
  const ownedQty = new Map((inventory ?? []).map((row) => [row.id, row.qty]))

  return (
    <div data-testid="pet-shop-tab" className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex items-center gap-3 rounded-lg border p-3">
        <CoinsIcon className="size-5 text-primary" />
        <span data-testid="pet-shop-balance" className="text-sm font-medium tabular-nums">
          {t("shop.balance", { coins })}
        </span>
        {streak.days > 0 && (
          <span
            data-testid="pet-shop-streak"
            className="ml-auto flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
          >
            <FlameIcon className="size-3.5 text-primary" />
            {t("shop.streak", { days: streak.days })}
          </span>
        )}
      </div>

      {CATEGORIES.map((category) => {
        const items = PET_ITEMS.filter((i) => i.category === category)
        if (items.length === 0) return null
        return (
          <section key={category} className="flex flex-col gap-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t(`shop.categories.${category}`)}
            </h3>
            <div className="grid gap-2 @md/pet-pane:grid-cols-2">
              {items.map((item) => {
                const Icon = petItemIcon(item.icon)
                const owned = ownedQty.get(item.id) ?? 0
                const affordable = canAfford(coins, item)
                return (
                  <div
                    key={item.id}
                    data-shop-item={item.id}
                    className="flex items-center gap-3 rounded-lg border p-3"
                  >
                    <Icon className="size-5 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <span className="truncate">{t(`shop.items.${item.i18nKey}.title`)}</span>
                        {owned > 0 && (
                          <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums">
                            {t("shop.owned", { qty: owned })}
                          </span>
                        )}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {t(`shop.items.${item.i18nKey}.description`)}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!affordable}
                        data-action={`buy-${item.id}`}
                        title={affordable ? undefined : t("shop.insufficient")}
                        onClick={() => void purchaseItem(item.id)}
                      >
                        <CoinsIcon className="size-3.5" />
                        <span className={cn("tabular-nums", !affordable && "opacity-60")}>
                          {item.price}
                        </span>
                      </Button>
                      {owned > 0 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          data-action={`use-${item.id}`}
                          onClick={() => void consumeItem(item.id)}
                        >
                          {item.consumable ? t("shop.use") : t("shop.apply")}
                        </Button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
