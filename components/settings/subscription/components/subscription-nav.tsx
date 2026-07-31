"use client"

// Grouped nav for the Subscription section's master/detail layout, replacing the
// two-level provider→inner tab strip. Markup mirrors `appearance-nav.tsx` /
// `ocr-sidebar.tsx`: an uppercase group header above `role="listitem"` buttons
// in a scrolling container. Deliberately not `role="tab"` — this is a list that
// drives a detail pane, not a tablist.

import type { ComponentType } from "react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import type { SubscriptionNavGroup, SubscriptionPanelId } from "../nav-config"

export interface SubscriptionNavProps {
  groups: readonly SubscriptionNavGroup[]
  activeId: SubscriptionPanelId
  onSelect: (id: SubscriptionPanelId) => void
}

export function SubscriptionNav({ groups, activeId, onSelect }: SubscriptionNavProps) {
  const t = useTranslations("subscription.nav")
  return (
    <div
      className="flex-1 overflow-x-hidden overflow-y-auto p-1"
      role="list"
      aria-label={t("title")}
    >
      {groups.map((group) => (
        <div key={group.id}>
          <div
            className="px-3 pt-3 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase"
            data-testid={`subscription-nav-group-${group.id}`}
          >
            {t(`groups.${group.id}`)}
          </div>
          {group.items.map((item) => (
            <SubscriptionNavItem
              key={item.id}
              id={item.id}
              icon={item.icon}
              label={t(`items.${item.id}.label`)}
              description={t(`items.${item.id}.description`)}
              isSelected={item.id === activeId}
              onSelect={onSelect}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function SubscriptionNavItem({
  id,
  icon: Icon,
  label,
  description,
  isSelected,
  onSelect,
}: {
  id: SubscriptionPanelId
  icon: ComponentType<{ className?: string }>
  label: string
  description: string
  isSelected: boolean
  onSelect: (id: SubscriptionPanelId) => void
}) {
  return (
    <div role="listitem">
      <button
        type="button"
        aria-current={isSelected ? "true" : undefined}
        data-testid={`subscription-nav-item-${id}`}
        data-active={isSelected}
        onClick={() => onSelect(id)}
        className={cn(
          "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition",
          "hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          "data-[active=true]:bg-accent data-[active=true]:text-accent-foreground"
        )}
      >
        <Icon className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{label}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{description}</span>
        </span>
      </button>
    </div>
  )
}
