"use client"

import { useTranslations } from "next-intl"
import { CircleIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { useConnectionState } from "@/hooks/companion/use-connection-state"
import { cn } from "@/lib/utils"

/**
 * Phase C1 — visible connection-state pill for the mobile companion.
 *
 * Surfaces `transport-companion.ts`'s `getConnectionState()` observable so
 * users have a quick "am I live" indicator without poking diagnostics.
 */
export function ConnectionStateBadge({ className }: { className?: string }) {
  const t = useTranslations("mobile.connectionState")
  const state = useConnectionState()
  if (!state) return null

  const styles = {
    connected: {
      labelKey: "live",
      tone: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    },
    reconnecting: {
      labelKey: "reconnecting",
      tone: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    },
    offline: {
      labelKey: "offline",
      tone: "border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
    },
    unauthenticated: {
      labelKey: "repairNeeded",
      tone: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
    },
  } as const

  const meta = styles[state]
  const label = t(meta.labelKey)
  return (
    <Badge
      variant="outline"
      role="status"
      aria-label={t("aria", { label })}
      className={cn(
        "gap-1.5 border px-2 py-0.5 font-mono text-[10px] uppercase",
        meta.tone,
        className
      )}
      data-testid="connection-state-badge"
      data-state={state}
    >
      <CircleIcon className="h-2 w-2 fill-current" aria-hidden="true" />
      {label}
    </Badge>
  )
}
