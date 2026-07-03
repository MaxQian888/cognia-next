// Quick-nav row from the interaction panel into the /pet console: one small
// button per high-traffic console tab (shop / customize / insights / dex /
// achievements). Pure presentation — the caller decides how navigation happens
// (router push in the widget, cross-window bridge in the desktop popup).

"use client"

import type { ComponentType } from "react"
import { useTranslations } from "next-intl"
import { BookOpenIcon, PaletteIcon, RadarIcon, ShoppingBagIcon, TrophyIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { PetConsoleTab } from "@/lib/pet/console-tabs"

const NAV_TABS: { tab: PetConsoleTab; Icon: ComponentType<{ className?: string }> }[] = [
  { tab: "shop", Icon: ShoppingBagIcon },
  { tab: "customize", Icon: PaletteIcon },
  { tab: "insights", Icon: RadarIcon },
  { tab: "dex", Icon: BookOpenIcon },
  { tab: "achievements", Icon: TrophyIcon },
]

export interface PetQuickNavProps {
  onNavigate: (tab: PetConsoleTab) => void
  className?: string
}

export function PetQuickNav({ onNavigate, className }: PetQuickNavProps) {
  const t = useTranslations("pet")
  return (
    <div data-testid="pet-quick-nav" className={cn("grid grid-cols-5 gap-1", className)}>
      {NAV_TABS.map(({ tab, Icon }) => (
        <Button
          key={tab}
          size="sm"
          variant="ghost"
          data-nav={tab}
          aria-label={t(`console.tabs.${tab}`)}
          className="h-auto flex-col gap-1 py-1.5 text-muted-foreground hover:text-foreground"
          onClick={() => onNavigate(tab)}
        >
          <Icon className="size-4" />
          <span className="text-[9px] leading-none">{t(`console.tabs.${tab}`)}</span>
        </Button>
      ))}
    </div>
  )
}
