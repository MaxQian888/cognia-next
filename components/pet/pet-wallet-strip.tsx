// The pet's wallet at a glance: coin balance, daily-care streak, and the
// streak's coin multiplier when it is earning one. Reads the raw optional
// profile fields (legacy rows predate the economy) and normalizes here. With
// `onOpenShop` the whole strip is a button that jumps to the shop.

"use client"

import { useTranslations } from "next-intl"
import { CoinsIcon, FlameIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { normalizeCoins, normalizeStreak, type PetStreak } from "@/types/pet"
import { coinMultiplier } from "@/lib/pet/economy/streak"

export interface PetWalletStripProps {
  coins?: number
  streak?: PetStreak
  /** Open the shop (console tab). Renders the strip as a button when given. */
  onOpenShop?: () => void
  className?: string
  variant?: "outlined" | "flat"
}

export function PetWalletStrip({
  coins,
  streak,
  onOpenShop,
  className,
  variant = "outlined",
}: PetWalletStripProps) {
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
        <Badge data-testid="pet-wallet-streak" className="ml-auto" variant="secondary">
          <FlameIcon className="size-3 text-primary" />
          {t("shop.streak", { days })}
        </Badge>
      )}
      {multiplier > 1 && (
        <Badge data-testid="pet-wallet-multiplier" variant="outline">
          {t("wallet.multiplier", { multiplier })}
        </Badge>
      )}
    </>
  )

  const layout = cn("flex items-center gap-2", variant === "outlined" && "rounded-lg border p-2.5")
  if (onOpenShop) {
    return (
      <Button
        type="button"
        variant="ghost"
        data-testid="pet-wallet-strip"
        data-variant={variant}
        aria-label={t("console.tabs.shop")}
        onClick={onOpenShop}
        className={cn(layout, "h-auto w-full justify-start text-left", className)}
      >
        {content}
      </Button>
    )
  }
  return (
    <div data-testid="pet-wallet-strip" data-variant={variant} className={cn(layout, className)}>
      {content}
    </div>
  )
}
