"use client"

/**
 * Start one run by hand, with the reason beside it when it cannot.
 *
 * Goes through the control-write facade, which enqueues a DELIVERY rather than
 * calling the runner. That is the whole point: a direct run would bypass the
 * lease, the concurrency key and the retry policy, so pressing this during a
 * busy period would run a second copy of work the queue was serialising.
 *
 * Disabled rather than hidden when the write plane cannot act. A phone paired
 * to a Host with no relay yet, a browser with no Host at all, and a Bot whose
 * plugin is gone are three different answers, and an absent button gives all
 * three the same one.
 *
 * The reason is text, not a tooltip. A tooltip on a DISABLED control is
 * unreachable with a finger and mostly unreachable with a keyboard, so the one
 * sentence explaining why the button does nothing would be visible only to a
 * mouse user who happened to hover.
 */

import { useTranslations } from "next-intl"
import { PlayIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useBotControlActions, useBotWriteReadiness } from "@/hooks/bots/use-bot-control-writes"
import { BOT_WRITE_COMMANDS } from "@/lib/bot/control-writes"
import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"

export function RunBotNowButton({ row }: { row: BotConsoleRow }) {
  const t = useTranslations("bots")
  const readiness = useBotWriteReadiness(BOT_WRITE_COMMANDS.runManual)
  const actions = useBotControlActions()

  // A manual run needs somewhere to attribute itself. A definition with no
  // manual trigger has not asked to be startable by hand, and starting its
  // schedule instead would run work under a payload it never expects.
  const manual = row.triggers.find((trigger) => trigger.kind === "manual")
  const blocked = row.orphaned
    ? t("run.blockedOrphan")
    : !manual
      ? t("run.blockedNoTrigger")
      : !readiness.can
        ? t(`write.reason.${readiness.availability.reason}`)
        : null

  const busy = actions.pending.has(`run:${row.id}`)

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="bot-run-now-row">
      <Button
        size="sm"
        variant="outline"
        disabled={blocked !== null || busy}
        onClick={() => void actions.runNow(row.id, manual?.id)}
        data-testid="bot-run-now"
      >
        {busy ? <Spinner className="size-3.5" /> : <PlayIcon className="size-3.5" aria-hidden />}
        {t("run.label")}
      </Button>
      {blocked ? (
        <p
          className="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground"
          data-testid="bot-run-now-blocked"
        >
          {blocked}
        </p>
      ) : null}
    </div>
  )
}
