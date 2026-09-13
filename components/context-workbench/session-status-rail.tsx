"use client"

import { AlertTriangleIcon, CircleDashedIcon, HandIcon, LoaderIcon } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"

/** The four states `useSessionOverviewState` collapses a session down to. */
export type SessionDisplayStatus = "idle" | "streaming" | "awaiting_approval" | "error"

/**
 * Tone per state.
 *
 * The hue lives in the wash, the border and the icon — never in the label.
 * `--warning` is `oklch(0.75 …)`, roughly 1.9:1 against a light substrate, so
 * `text-warning` on a tinted background would be unreadable; the label stays on
 * `--foreground` and the icon-plus-text pair is what carries the state, which
 * is also what keeps colour from being the sole signal (WCAG 1.4.1).
 */
const TONES: Record<
  SessionDisplayStatus,
  { icon: LucideIcon; surface: string; accent: string; spin?: boolean }
> = {
  idle: {
    icon: CircleDashedIcon,
    surface: "border-border bg-muted/40",
    accent: "text-muted-foreground",
  },
  streaming: {
    icon: LoaderIcon,
    surface: "border-info/40 bg-info/10",
    accent: "text-info",
    spin: true,
  },
  awaiting_approval: {
    icon: HandIcon,
    surface: "border-warning/45 bg-warning/12",
    accent: "text-warning",
  },
  error: {
    icon: AlertTriangleIcon,
    surface: "border-destructive/40 bg-destructive/10",
    accent: "text-destructive",
  },
}

export interface SessionStatusRailProps {
  displayStatus: SessionDisplayStatus
  /** Rendered as the rail's second line when the session is in `error`. */
  error?: string | null
  className?: string
}

/**
 * One tinted banner naming what the session is doing right now, shared by the
 * compact summary card and the full overview panel so the two cannot describe
 * the same state differently.
 *
 * It replaces a `<Badge variant="secondary">` that painted idle, working and
 * waiting-for-you in the identical grey — the one state a glance actually needs
 * to separate was the one the card never distinguished.
 */
export function SessionStatusRail({ displayStatus, error, className }: SessionStatusRailProps) {
  const t = useTranslations("contextWorkbench.taskOverview")
  const tone = TONES[displayStatus]
  const Icon = tone.icon
  // Only `error` carries a live payload; the other three read from the
  // catalogue, and `idle` deliberately has no second line at all.
  const hint =
    displayStatus === "error"
      ? (error ?? t("statusHints.error"))
      : displayStatus === "idle"
        ? null
        : t(`statusHints.${displayStatus}`)
  return (
    <div
      role={displayStatus === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-lg border px-2 py-1.5",
        tone.surface,
        className
      )}
    >
      <Icon
        className={cn("mt-px size-3.5 shrink-0", tone.accent, tone.spin && "animate-spin")}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium leading-snug">{t(`statuses.${displayStatus}`)}</p>
        {hint ? (
          <p
            className={cn(
              "break-words text-[11px] leading-snug",
              displayStatus === "error" ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  )
}
