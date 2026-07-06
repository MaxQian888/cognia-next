"use client"

import React, { useCallback } from "react"
import { useTranslations } from "next-intl"
import { Check, AlertTriangle, X, Circle, Info } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

export type ProviderConnectionStatus =
  | "connected"
  | "warning"
  | "not-configured"
  | "error"
  | "limited"

interface ProviderSidebarItemProps {
  providerId: string
  name: string
  icon?: string | React.ReactNode
  subtitle: string
  status: ProviderConnectionStatus
  isSelected: boolean
  onClick: (providerId: string) => void
  modelCount?: number
}

/**
 * Per-status presentation. `labelKey` / `reasonKey` resolve under the
 * `providers.sidebar` namespace — the reason is surfaced as a native tooltip on
 * the badge so a "warning"/"error" provider explains itself on hover and the
 * user knows the row is worth opening.
 */
const STATUS_CONFIG: Record<
  ProviderConnectionStatus,
  {
    icon: React.ComponentType<{ className?: string }>
    labelKey: string
    reasonKey: string
    className: string
  }
> = {
  connected: {
    icon: Check,
    labelKey: "statusConnected",
    reasonKey: "reasonConnected",
    className:
      "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400",
  },
  warning: {
    icon: AlertTriangle,
    labelKey: "statusWarning",
    reasonKey: "reasonWarning",
    className:
      "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400",
  },
  "not-configured": {
    icon: Circle,
    labelKey: "statusUnconfigured",
    reasonKey: "reasonUnconfigured",
    className: "border-muted-foreground/20 bg-muted/50 text-muted-foreground",
  },
  error: {
    icon: X,
    labelKey: "statusError",
    reasonKey: "reasonError",
    className:
      "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400",
  },
  // Verified but with caveats (e.g. authoritative verification wasn't
  // possible in this runtime) — distinct from a plain "connected" pass so
  // the sidebar badge doesn't overclaim.
  limited: {
    icon: Info,
    labelKey: "statusLimited",
    reasonKey: "reasonLimited",
    className:
      "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400",
  },
}

const PROVIDER_ICON_MAP: Record<string, string> = {
  openai: "O",
  anthropic: "A",
  google: "G",
  deepseek: "D",
  groq: "Q",
  mistral: "M",
  cohere: "C",
  ollama: "L",
  openrouter: "R",
  together: "T",
  fireworks: "F",
  cerebras: "B",
  xai: "X",
  sambanova: "S",
}

function getProviderIcon(providerId: string): string {
  const base = providerId.toLowerCase().replace(/[^a-z]/g, "")
  for (const [key, letter] of Object.entries(PROVIDER_ICON_MAP)) {
    if (base.includes(key)) return letter
  }
  return providerId.charAt(0).toUpperCase()
}

export const ProviderSidebarItem = React.memo(function ProviderSidebarItem({
  providerId,
  name,
  icon,
  subtitle,
  status,
  isSelected,
  onClick,
  modelCount,
}: ProviderSidebarItemProps) {
  const t = useTranslations("providers.sidebar")
  const handleClick = useCallback(() => onClick(providerId), [onClick, providerId])
  const statusCfg = STATUS_CONFIG[status]
  const StatusIcon = statusCfg.icon
  const statusLabel = t(statusCfg.labelKey)
  const statusReason = t(statusCfg.reasonKey)

  return (
    <button
      type="button"
      id={`provider-${providerId}`}
      onClick={handleClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-all duration-200",
        isSelected
          ? "border-l-2 border-l-primary bg-primary text-primary-foreground"
          : "hover:bg-muted/50"
      )}
    >
      <div
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold",
          isSelected ? "bg-primary-foreground/20" : "bg-muted"
        )}
      >
        {icon ?? getProviderIcon(providerId)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{name}</span>
          {modelCount !== undefined && modelCount > 0 && (
            <Badge
              variant="secondary"
              className={cn(
                "shrink-0 text-[10px] px-1 py-0",
                isSelected &&
                  "bg-primary-foreground/20 text-primary-foreground border-primary-foreground/30"
              )}
            >
              {modelCount}
            </Badge>
          )}
        </div>
        <div
          className={cn(
            "truncate text-xs",
            isSelected ? "text-primary-foreground/70" : "text-muted-foreground"
          )}
        >
          {subtitle}
        </div>
      </div>
      <Badge
        variant="outline"
        data-status={status}
        title={statusReason}
        aria-label={`${statusLabel} — ${statusReason}`}
        className={cn("shrink-0 gap-1 text-[10px] px-1.5 py-0", statusCfg.className)}
      >
        <StatusIcon className="h-3 w-3" />
        <span className="hidden sm:inline">{statusLabel}</span>
      </Badge>
    </button>
  )
})
