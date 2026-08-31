"use client"

/**
 * Quiet-hours chip for the conversation header.
 *
 * Surfaces the effective quiet window for a conversation — the per-conversation
 * override quiet hours take precedence over the adapter-level window (matching
 * the outbound-runner's resolution order). Shows a "Quiet until HH:MM" warning
 * state while the window is active, otherwise the configured window. Reuses the
 * runner's `isInQuietHours` so the UI and the delivery gate agree.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { InboxChip } from "./inbox-chip"
import { MoonIcon } from "lucide-react"
import { useAdapterInstance } from "@/hooks/connectors/use-adapter-instance"
import { useConversationOverride } from "@/hooks/connectors/use-conversation-overrides"
import { isInQuietHours } from "@/lib/connectors/outbound-runner"

interface QuietHoursChipProps {
  adapterId: string
  conversationKey: string
}

export function QuietHoursChip({ adapterId, conversationKey }: QuietHoursChipProps) {
  const t = useTranslations("inbox.quietHours")
  const adapter = useAdapterInstance(adapterId)
  const override = useConversationOverride(conversationKey)
  // Re-tick once a minute so the active/inactive state stays current without
  // an impure read in the render body.
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const quiet = override?.quietHours ?? adapter?.quietHours
  if (!quiet) return null

  const active = isInQuietHours(now, quiet.from, quiet.to, quiet.tz)

  return (
    <InboxChip
      variant={active ? "warning" : "outline"}
      icon={<MoonIcon className="size-3" />}
      aria-label={
        active
          ? t("ariaActive", { time: quiet.to })
          : t("ariaInactive", { from: quiet.from, to: quiet.to, tz: quiet.tz })
      }
      data-testid="quiet-hours-chip"
      dataAttributes={{ "data-active": active }}
      tooltip={t("tooltip", { from: quiet.from, to: quiet.to, tz: quiet.tz })}
    >
      {active ? t("active", { time: quiet.to }) : t("inactive", { from: quiet.from, to: quiet.to })}
    </InboxChip>
  )
}
