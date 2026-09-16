"use client"

/**
 * What wakes this Bot up, and which of those are armed.
 *
 * The switch writes through `lib/bot/control-writes`, never Dexie: arming a
 * cron trigger has to reconcile a scheduler row, and a raw
 * `botInstallations.put` here would arm a schedule nothing ever fires. The
 * same facade routes the write to a paired Host when this shell is not the one
 * that runs the Bot, so one switch is correct on a desktop and on a phone.
 *
 * When the write plane cannot act, the switch is rendered and DISABLED with
 * the reason beneath it, not hidden. Hiding it collapses three different
 * answers into one: this Bot has no such trigger, this shell cannot arm it
 * from here, and it is armed already.
 *
 * A disarmed trigger is rendered too. "This Bot has no schedule" and "this Bot
 * has a schedule that is switched off" are different answers, and dropping the
 * row makes them look identical.
 */

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Switch } from "@/components/ui/switch"
import { useBotControlActions, useBotWriteReadiness } from "@/hooks/bots/use-bot-control-writes"
import { BOT_WRITE_COMMANDS } from "@/lib/bot/control-writes"
import type { BotConsoleRow, BotTriggerSummary } from "@/lib/bot/console/bot-rows"
import { cn } from "@/lib/utils"

import { BotTriggerIcon, useBotIntervalText } from "../bot-visuals"

interface TriggerRowProps {
  trigger: BotTriggerSummary
  canArm: boolean
  busy: boolean
  onArmedChange: (armed: boolean) => void
}

function TriggerRow({ trigger, canArm, busy, onArmedChange }: TriggerRowProps) {
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
              "min-w-0 flex-1 truncate text-xs font-medium",
              !trigger.armed && "text-muted-foreground"
            )}
          >
            {title}
          </span>
          <Switch
            checked={trigger.armed}
            disabled={!canArm || busy}
            onCheckedChange={onArmedChange}
            aria-label={t("trigger.armAria", { name: title })}
            data-testid={`bot-trigger-switch-${trigger.id}`}
          />
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {t(`trigger.kind.${trigger.kind}`)}
          {detail ? ` · ${detail}` : ""}
        </p>
        {trigger.configFallback ? (
          <Badge
            variant="outline"
            className="mt-1 text-[10px]"
            data-testid={`bot-trigger-fallback-${trigger.id}`}
          >
            {t(`trigger.configFallback.${trigger.configFallback}`)}
          </Badge>
        ) : null}
      </div>
    </li>
  )
}

export function BotTriggersSection({ row }: { row: BotConsoleRow }) {
  const t = useTranslations("bots")
  const readiness = useBotWriteReadiness(BOT_WRITE_COMMANDS.setTriggerArmed)
  const actions = useBotControlActions()

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

  // An orphan has no definition to reconcile against, so arming one would
  // write an override for a trigger that no longer exists.
  const canArm = readiness.can && !row.orphaned

  return (
    <div className="flex flex-col gap-2">
      <ul className="divide-y" data-testid="bot-triggers">
        {row.triggers.map((trigger) => (
          <TriggerRow
            key={trigger.id}
            trigger={trigger}
            canArm={canArm}
            busy={actions.pending.has(`trigger:${trigger.id}`)}
            onArmedChange={(armed) => void actions.setTriggerArmed(row.id, trigger.id, armed)}
          />
        ))}
      </ul>
      {!canArm ? (
        // Rendered rather than hidden: a disabled switch with a reason says
        // "not from here", where an absent one says "this Bot has no trigger".
        <p className="text-[11px] leading-snug text-muted-foreground" data-testid="bot-arm-blocked">
          {row.orphaned
            ? t("trigger.armBlockedOrphan")
            : t(`write.reason.${readiness.availability.reason}`)}
        </p>
      ) : null}
    </div>
  )
}
