"use client"

/**
 * What wakes this Bot up, and which of those are armed.
 *
 * Read-only here on purpose. Arming a trigger is a write that has to route
 * through the same seam on a desktop and on a phone, so the switch arrives
 * with that seam rather than as a direct Dexie write this component would
 * later have to give up.
 *
 * A disarmed trigger is rendered, not hidden. "This Bot has no schedule" and
 * "this Bot has a schedule that is switched off" are different answers, and
 * dropping the row makes them look identical.
 */

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import type { BotConsoleRow, BotTriggerSummary } from "@/lib/bot/console/bot-rows"
import { cn } from "@/lib/utils"

import { BotTriggerIcon, useBotIntervalText } from "../bot-visuals"

function TriggerRow({ trigger }: { trigger: BotTriggerSummary }) {
  const t = useTranslations("bots")
  const interval = useBotIntervalText()

  // The author's own label wins when there is one. `labelKey` is the
  // translated form, but it names a key in the OWNING PLUGIN's catalogue, not
  // in ours, so it cannot be resolved from here and the literal label is what
  // is left. Falling back to the kind keeps the row readable either way.
  const title = trigger.label ?? t(`trigger.kind.${trigger.kind}`)

  const detail =
    trigger.everyMs !== undefined
      ? [interval(trigger.everyMs), trigger.detail].filter(Boolean).join(" · ")
      : trigger.detail

  return (
    <li
      className="flex items-start gap-2.5 py-2 first:pt-0 last:pb-0"
      data-testid={`bot-trigger-${trigger.id}`}
      data-armed={trigger.armed ? "true" : "false"}
    >
      <BotTriggerIcon kind={trigger.kind} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "min-w-0 truncate text-xs font-medium",
              !trigger.armed && "text-muted-foreground"
            )}
          >
            {title}
          </span>
          <Badge
            variant="outline"
            className={cn(
              "shrink-0 font-normal",
              trigger.armed ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
            )}
          >
            {t(trigger.armed ? "trigger.armed" : "trigger.disarmed")}
          </Badge>
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {t(`trigger.kind.${trigger.kind}`)}
          {detail ? ` · ${detail}` : ""}
        </p>
      </div>
    </li>
  )
}

export function BotTriggersSection({ row }: { row: BotConsoleRow }) {
  const t = useTranslations("bots")

  if (row.triggers.length === 0) {
    return (
      <Empty className="border-none py-4">
        <EmptyHeader>
          <EmptyTitle className="text-sm">
            {row.orphaned ? t("triggers.orphanTitle") : t("triggers.emptyTitle")}
          </EmptyTitle>
          <EmptyDescription className="text-xs">
            {row.orphaned ? t("triggers.orphanBody") : t("triggers.emptyBody")}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <ul className="divide-y" data-testid="bot-triggers">
      {row.triggers.map((trigger) => (
        <TriggerRow key={trigger.id} trigger={trigger} />
      ))}
    </ul>
  )
}
