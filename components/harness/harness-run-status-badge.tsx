"use client"

import type { ComponentProps } from "react"
import { StatusBadge } from "@/components/status-badge"
import type { Badge } from "@/components/ui/badge"
import { statusTone } from "@/lib/harness/run-view"
import type { HarnessRunStatus } from "@/types/harness/evolution"

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>["variant"]>

const TONE_VARIANT: Record<ReturnType<typeof statusTone>, BadgeVariant> = {
  neutral: "outline",
  working: "secondary",
  attention: "warning",
  good: "success",
  bad: "destructive",
}

/** A run's status, translated, toned the way `statusTone` reads it. */
export function HarnessRunStatusBadge({
  status,
  className,
}: {
  status: HarnessRunStatus
  className?: string
}) {
  const tone = statusTone(status)
  return (
    <StatusBadge
      value={status}
      labelNamespace="harnessEvolution.status"
      variantMap={{ [status]: TONE_VARIANT[tone] }}
      pulse={tone === "working"}
      className={className}
      data-testid="harness-run-status"
      data-tone={tone}
    />
  )
}
