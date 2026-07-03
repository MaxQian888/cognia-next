// The pet's wallet at a glance: coin balance, daily-care streak, and the
// streak's coin multiplier when it is earning one. Reads the raw optional
// profile fields (legacy rows predate the economy) and normalizes here. With
// `onOpenShop` the whole strip is a button that jumps to the shop.

"use client"

import { useTranslations } from "next-intl"
import { CoinsIcon, FlameIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { normalizeCoins, normalizeStreak, type PetStreak } from "@/types/pet"
import { coinMultiplier } from "@/lib/pet/economy/streak"

export interface PetWalletStripProps {
  coins?: number
  streak?: PetStreak
  /** Open the shop (console tab). Renders the strip as a button when given. */
  onOpenShop?: () => void
  className?: string
}

export function PetWalletStrip({ coins, streak, onOpenShop, className }: PetWalletStripProps) {
  const t = useTranslations("pet")
  const balance = normalizeCoins(coins)
  const days = normalizeStreak(streak).days
  const multiplier = coinMultiplier(days)

  const content = (
    <>
      <CoinsIcon className="size-4 shrink-0 text-primary" />
      <span data-testid="pet-wallet-balance" className="text-xs font-medium tabular-nums">
        {t("shop.balance", { coins: balance })}
      </span>
      {days > 0 && (
        <span
          data-testid="pet-wallet-streak"
          className="ml-auto flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px]"
        >
          <FlameIcon className="size-3 text-primary" />
          {t("shop.streak", { days })}
        </span>
      )}
      {multiplier > 1 && (
        <span
          data-testid="pet-wallet-multiplier"
          className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary tabular-nums"
        >
          {t("wallet.multiplier", { multiplier })}
        </span>
      )}
    </>
  )

  const layout = "flex items-center gap-2 rounded-lg border p-2.5"
  if (onOpenShop) {
    return (
      <button
        type="button"
        data-testid="pet-wallet-strip"
        aria-label={t("console.tabs.shop")}
        onClick={onOpenShop}
        className={cn(layout, "w-full text-left transition-colors hover:bg-muted/50", className)}
      >
        {content}
      </button>
    )
  }
  return (
    <div data-testid="pet-wallet-strip" className={cn(layout, className)}>
      {content}
    </div>
  )
}
