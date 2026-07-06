"use client"

/**
 * GoalsMobileSectionSwitcher — the mobile Goals view's read-only section nav:
 * a horizontally-scrollable chip strip over Overview / History / Analytics
 * (authoring / templates / tracker stay desktop-only). Mirrors the markup
 * idiom of `CategoryChipStrip` (which is coupled to the discover layout, so it
 * can't be reused directly) so the two mobile surfaces feel identical.
 */

import { useTranslations } from "next-intl"
import { BarChart3Icon, HistoryIcon, LayoutDashboardIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type GoalMobileSection = "overview" | "history" | "analytics"

const SECTIONS: { id: GoalMobileSection; icon: typeof LayoutDashboardIcon }[] = [
  { id: "overview", icon: LayoutDashboardIcon },
  { id: "history", icon: HistoryIcon },
  { id: "analytics", icon: BarChart3Icon },
]

export interface GoalsMobileSectionSwitcherProps {
  active: GoalMobileSection
  onSelect: (section: GoalMobileSection) => void
  className?: string
}

export function GoalsMobileSectionSwitcher({
  active,
  onSelect,
  className,
}: GoalsMobileSectionSwitcherProps) {
  const t = useTranslations("goal")

  return (
    <div
      role="tablist"
      aria-label={t("console.sectionsAria")}
      data-testid="mobile-goals-switcher"
      className={cn(
        "flex w-full snap-x snap-mandatory items-center gap-2 overflow-x-auto",
        "px-4 pb-1 [&::-webkit-scrollbar]:hidden",
        className
      )}
    >
      {SECTIONS.map(({ id, icon: Icon }) => {
        const isActive = id === active
        return (
          <Button
            key={id}
            type="button"
            role="tab"
            variant={isActive ? "default" : "outline"}
            size="sm"
            onClick={() => onSelect(id)}
            aria-selected={isActive}
            aria-current={isActive ? "page" : undefined}
            data-testid={`mobile-goals-section-${id}`}
            className={cn(
              "shrink-0 snap-start gap-1.5 whitespace-nowrap",
              isActive ? "font-medium" : "font-normal"
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            {t(`console.tabs.${id}`)}
          </Button>
        )
      })}
    </div>
  )
}

GoalsMobileSectionSwitcher.displayName = "GoalsMobileSectionSwitcher"
