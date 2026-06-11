"use client"

/**
 * SLA response-deadline badge (CRM, schema v83). Read-only chip that shows how
 * long the operator has left to reply ("Due in 2h") or a red **Overdue** state
 * once the next-response deadline has passed. Self-hides when no deadline is
 * set or the conversation is resolved, so it never clutters conversations
 * without an SLA. The deadline is populated by the connector bus on inbound
 * and cleared by the outbound runner on reply (markResponded).
 *
 * Mirrors LastInboundChip's lazy-now + 30s tick so the countdown stays current
 * without an impure read in the render body.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { isOverdue } from "@/lib/connectors/sla"
import type { ConversationStatus } from "@/lib/db/conversation-overrides"

export interface SlaBadgeProps {
  nextResponseDueAt?: number
  status?: ConversationStatus
}

/** Humanize a positive remaining-ms span as a compact "2h" / "45m" / "30s". */
function humanizeRemaining(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

export function SlaBadge({ nextResponseDueAt, status }: SlaBadgeProps) {
  const t = useTranslations("inbox.sla")
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  if (!nextResponseDueAt || status === "resolved") return null

  const overdue = isOverdue({ nextResponseDueAt, status }, now)
  const remaining = nextResponseDueAt - now

  return (
    <Badge
      variant={overdue ? "destructive" : "outline"}
      className="hidden md:inline-flex text-xs"
      data-testid="sla-badge"
      aria-label={overdue ? t("overdueAria") : t("dueAria", { time: humanizeRemaining(remaining) })}
    >
      {overdue ? t("overdue") : t("dueIn", { time: humanizeRemaining(remaining) })}
    </Badge>
  )
}
