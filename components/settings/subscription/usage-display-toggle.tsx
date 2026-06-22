"use client"

/**
 * Quick 3-way toggle for the usage / consumption display mode, mounted in the
 * Subscription → Usage toolbar. Mirrors the chat-header `AgentFlowDisplayToggle`
 * (shadcn `ToggleGroup`) but is bound to the global `useUsageDisplayMode`, so it
 * stays in sync with the appearance settings card and applies to every usage
 * surface (dashboard, composer read-out, agent-team tile, mobile stats).
 */

import { useTranslations } from "next-intl"
import { LayoutListIcon, ListTreeIcon, Rows3Icon } from "lucide-react"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useUsageDisplayMode } from "@/hooks/usage/use-usage-display-mode"
import { isUsageDisplayMode } from "@/types/appearance"

export interface UsageDisplayToggleProps {
  className?: string
}

export function UsageDisplayToggle({ className }: UsageDisplayToggleProps) {
  const t = useTranslations("subscription.usage.display")
  const { mode, setMode } = useUsageDisplayMode()

  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={mode}
      onValueChange={(value) => {
        if (isUsageDisplayMode(value)) setMode(value)
      }}
      aria-label={t("aria")}
      className={className}
      data-testid="usage-display-toggle"
    >
      <ToggleGroupItem
        value="simplified"
        aria-label={t("simplified")}
        data-testid="usage-display-simplified"
      >
        <Rows3Icon className="size-3.5" />
      </ToggleGroupItem>
      <ToggleGroupItem
        value="standard"
        aria-label={t("standard")}
        data-testid="usage-display-standard"
      >
        <LayoutListIcon className="size-3.5" />
      </ToggleGroupItem>
      <ToggleGroupItem
        value="detailed"
        aria-label={t("detailed")}
        data-testid="usage-display-detailed"
      >
        <ListTreeIcon className="size-3.5" />
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
