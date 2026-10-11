"use client"

/**
 * The app bar's Glance button (ADR-0225 §9): opens the Glance drawer.
 *
 * It carries the one signal worth seeing from any screen: something is
 * waiting for the user (an approval, a question) or failed. The waiting count
 * is read from the Fleet mirror the phone already holds, which updates live
 * whether or not a glance module is on screen; a failure from the newest
 * glance reading. The button only signals: approvals stay on the Fleet page.
 *
 * `variant="menu"` is the same door as an overflow-menu row, for app bars too
 * narrow to hold the icon; it keeps the dot.
 */

import { useTranslations } from "next-intl"
import { GaugeIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { useFleetSnapshot } from "@/hooks/fleet/use-fleet-snapshot"
import { fleetStatusSummary } from "@/lib/fleet/format"
import { cn } from "@/lib/utils"

import { useMobileGlanceContext } from "./mobile-glance-provider"

export type GlanceAttention = "warn" | "error" | null

/** The dot to show: waiting beats failed, since it is the one a person can unblock. */
export function useGlanceAttention(): GlanceAttention {
  const { glance } = useMobileGlanceContext()
  const { snapshot } = useFleetSnapshot()
  const waiting = fleetStatusSummary(snapshot.sessions).attention
  const fleet = glance.snapshot.fleet
  if (waiting > 0 || (fleet?.counts.awaiting ?? 0) > 0) return "warn"
  if ((fleet?.counts.failed ?? 0) > 0) return "error"
  return null
}

function AttentionDot({ attention, className }: { attention: GlanceAttention; className?: string }) {
  if (!attention) return null
  return (
    <span
      aria-hidden
      data-testid="mobile-glance-attention"
      data-attention={attention}
      className={cn(
        "size-2 rounded-full",
        attention === "warn" ? "bg-warning" : "bg-destructive",
        className
      )}
    />
  )
}

export function MobileGlanceTrigger({
  variant = "icon",
  className,
}: {
  variant?: "icon" | "menu"
  className?: string
}) {
  const t = useTranslations("glance.mobile")
  const { setDrawerOpen } = useMobileGlanceContext()
  const attention = useGlanceAttention()
  const label = attention ? t("openAttention") : t("open")

  if (variant === "menu") {
    return (
      <DropdownMenuItem
        // Defer so the menu can close before the drawer takes focus.
        onSelect={() => setTimeout(() => setDrawerOpen(true), 0)}
        data-testid="mobile-action-glance"
      >
        <GaugeIcon className="size-4" />
        <span>{t("title")}</span>
        <AttentionDot attention={attention} className="ms-auto" />
      </DropdownMenuItem>
    )
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("relative touch-target", className)}
      aria-label={label}
      onClick={() => setDrawerOpen(true)}
      data-testid="mobile-glance-trigger"
    >
      <GaugeIcon className="size-5" />
      <AttentionDot attention={attention} className="absolute right-1 top-1" />
    </Button>
  )
}

/**
 * The Glance button's dot on the ⋮ trigger, for app bars that folded the
 * button into the menu. Folding a control moves its dot, it does not delete it.
 */
export function MobileGlanceFoldedDot({ className }: { className?: string }) {
  return <AttentionDot attention={useGlanceAttention()} className={className} />
}
