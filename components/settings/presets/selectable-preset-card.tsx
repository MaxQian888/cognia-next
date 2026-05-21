"use client"

// Shared card chrome for the "currently selected preset" idiom used by:
//   - `components/settings/subscription/preset-picker.tsx` (active ProviderPreset display)
//   - `components/chat/chat-header-preset-pill.tsx` Popover rows (system-prompt
//     preset picker surfaced from the chat header)
// Both call sites share the same visual cadence: title + a status badge,
// an optional subtitle, free-form details, and a right-aligned actions
// cluster. The component is data-agnostic — callers pass content via slots
// so ProviderPreset and SystemPromptPreset can stay separate types.

import * as React from "react"

import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

export type SelectablePresetBadge = "active" | "inactive" | "builtin" | "default" | "favorite"

export interface SelectablePresetCardProps {
  title: React.ReactNode
  subtitle?: React.ReactNode
  /** Visual status badge variant — picks color + treatment. */
  badge?: SelectablePresetBadge
  /** Localized text for the badge — required when `badge` is set. */
  badgeLabel?: React.ReactNode
  /** Free-form content area below subtitle (key/value rows, details, etc.). */
  details?: React.ReactNode
  /** Right-aligned action buttons cluster. */
  actions?: React.ReactNode
  onClick?: () => void
  selected?: boolean
  disabled?: boolean
  /** Optional leading slot (icon, avatar, or color swatch). */
  leading?: React.ReactNode
  className?: string
  testId?: string
}

const BADGE_VARIANT: Record<SelectablePresetBadge, "default" | "secondary" | "outline"> = {
  active: "default",
  inactive: "outline",
  builtin: "secondary",
  default: "default",
  favorite: "default",
}

export function SelectablePresetCard({
  title,
  subtitle,
  badge,
  badgeLabel,
  details,
  actions,
  onClick,
  selected = false,
  disabled = false,
  leading,
  className,
  testId,
}: SelectablePresetCardProps) {
  const interactive = Boolean(onClick) && !disabled

  const handleKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      onClick?.()
    }
  }

  return (
    <Card
      data-testid={testId}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? () => onClick?.() : undefined}
      onKeyDown={interactive ? handleKey : undefined}
      aria-pressed={interactive ? selected : undefined}
      aria-disabled={disabled || undefined}
      className={cn(
        "p-3 transition-colors",
        interactive &&
          "cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-primary bg-primary/10",
        disabled && "cursor-not-allowed opacity-60",
        className
      )}
    >
      <div className="flex items-start gap-3">
        {leading && (
          <div className="shrink-0" aria-hidden>
            {leading}
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 text-sm font-medium">{title}</div>
            {badge && (
              <Badge
                variant={BADGE_VARIANT[badge]}
                className="text-[10px]"
                data-testid="selectable-preset-card-badge"
              >
                {badgeLabel ?? badge}
              </Badge>
            )}
          </div>
          {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
          {details && <div className="text-xs">{details}</div>}
        </div>
        {actions && (
          <div
            className="flex shrink-0 items-center gap-1"
            data-testid="selectable-preset-card-actions"
          >
            {actions}
          </div>
        )}
      </div>
    </Card>
  )
}
