"use client"

/**
 * Per-field marker for config the listener reads once, when it binds.
 *
 * Every other gateway field is read live on each request, so these five are
 * the only ones where "saved" and "in effect" can disagree. The badge says so
 * before an edit ("applies on restart") and after one ("restart pending"),
 * with the pending state coming from Rust's `pendingRestartFields` rather than
 * from what this page happens to remember.
 */

import { useTranslations } from "next-intl"

import { MotionStatusSwap } from "@/components/chat/motion/motion-reveal"
import { Badge } from "@/components/ui/badge"
import type { GatewayBindTimeField } from "@/types/gateway"

export interface BindTimeBadgeProps {
  field: GatewayBindTimeField
  /** `GatewayStatus.pendingRestartFields` — empty while the listener is stopped. */
  pending: readonly GatewayBindTimeField[]
}

export function BindTimeBadge({ field, pending }: BindTimeBadgeProps) {
  const t = useTranslations("settings.gateway")
  const isPending = pending.includes(field)

  return (
    <MotionStatusSwap swapKey={isPending ? "pending" : "idle"}>
      <Badge
        variant={isPending ? "warning" : "outline"}
        className="text-[10px] font-normal"
        data-testid={`gateway-bind-time-${field}`}
        data-pending={isPending}
      >
        {t(isPending ? "restartPendingBadge" : "bindTimeBadge")}
      </Badge>
    </MotionStatusSwap>
  )
}
