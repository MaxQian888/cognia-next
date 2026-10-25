"use client"

/**
 * The recipients this Bot's runs may reach with nobody watching (ADR-0239).
 *
 * Only this installation's runs: its agent turn carries the list, and a
 * handler Bot's own plugin code is covered while a run is live. A bot
 * account's own list (the connector settings) covers every send through that
 * account and is not repeated here. Conversations, email and GitHub
 * repositories (ADR-0239 phase 2: a Bot's GitHub writes outside the PR or
 * issue its event is about); a member is named within one bot account, so
 * that list is where members go.
 *
 * A paired client relays the write to its Host like the other lifecycle
 * writes, and a placeholder of a Bot the Host runs cannot be edited here.
 */

import { useTranslations } from "next-intl"

import { OutboundRecipientsEditor } from "@/components/outbound/outbound-recipients-editor"
import {
  useBotLifecycleActions,
  useBotLifecycleReadiness,
} from "@/hooks/bots/use-bot-lifecycle-actions"
import { useKnownConversations } from "@/hooks/outbound/use-known-conversations"
import { useKnownRepositories } from "@/hooks/outbound/use-known-repositories"
import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"

const BOT_KINDS = ["conversation", "mail", "repository"] as const

export function BotOutboundRecipientsSection({ row }: { row: BotConsoleRow }) {
  const t = useTranslations("bots")
  const readiness = useBotLifecycleReadiness()
  const actions = useBotLifecycleActions()
  const known = useKnownConversations()
  const repositories = useKnownRepositories()
  const busy = actions.pending.has(`recipients:${row.id}`)

  return (
    <div className="flex flex-col gap-2" data-testid="bot-outbound-recipients">
      <OutboundRecipientsEditor
        value={row.outboundRecipients ?? []}
        onSave={(next) => actions.saveOutboundRecipients(row.id, next)}
        kinds={BOT_KINDS}
        knownConversations={known}
        knownRepositories={repositories}
        disabled={!readiness.can || busy || row.owner !== undefined}
        testId="bot-outbound-recipients-editor"
      />
      {!readiness.can ? (
        <p className="text-[11px] leading-snug text-muted-foreground">
          {t(`write.reason.${readiness.availability.reason}`)}
        </p>
      ) : null}
    </div>
  )
}
