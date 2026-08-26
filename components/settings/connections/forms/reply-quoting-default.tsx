"use client"

/**
 * ReplyQuotingDefault — bot-wide default for quoting the triggering message
 * on ai-run replies in group / thread chats (ADR-0009 §3A.3).
 *
 * Edits `AdapterInstanceRow.replyQuoting` (undefined / true = ON, false =
 * OFF). Per-conversation overrides (`ConversationOverrideRow.replyQuoting`,
 * edited in the Inbox override form) win over this default; the runtime
 * resolves `override ?? adapter ?? true`.
 *
 * Same self-managing pattern as `OutboundTuning`: takes only `adapterId`,
 * reads the row via `useLiveQuery`, persists immediately through
 * `updateAdapterInstance`, and is mounted ONCE in `config-detail.tsx`.
 *
 * Where the bot cannot quote at all the switch is rendered DISABLED with the
 * reason, not hidden. It used to `return null`, citing CLAUDE.md rule 7 —
 * which asks for the opposite: dormancy must be *labeled inert in the UI*.
 * Hiding is not a label. It cost the operator the difference between "DingTalk
 * has no reply primitive" (true on 4 of 11 platforms, and permanent) and "the
 * settings page failed to load".
 */

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { getDb } from "@/lib/db/schema"
import { updateAdapterInstance } from "@/lib/db/adapter-instances"
import { CapabilityNotice } from "@/components/connectors/capability-notice"
import { capabilityAvailability } from "@/lib/connectors/capability-availability"
import { effectiveCapabilitiesForRow } from "@/lib/connectors/effective-capabilities"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

export interface ReplyQuotingDefaultProps {
  adapterId: string
}

export function ReplyQuotingDefault({ adapterId }: ReplyQuotingDefaultProps) {
  const t = useTranslations("settings.connections.replyQuotingDefault")

  const row = useLiveQuery<AdapterInstanceRow | undefined>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve(undefined)
        : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )

  if (!row) return null
  // What THIS bot can do, not what the platform implements: a Slack grant
  // without `chat:write` cannot reply at all, and four platforms have no reply
  // primitive to begin with.
  const quoting = capabilityAvailability(effectiveCapabilitiesForRow(row), "send.reply")

  const enabled = row.replyQuoting !== false

  const toggle = (on: boolean): void => {
    // ON is the default — store `undefined` rather than `true` so a row
    // that was never touched and a row switched back on look the same.
    void updateAdapterInstance(adapterId, { replyQuoting: on ? undefined : false })
  }

  return (
    <Card data-testid="reply-quoting-default">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("description")}</p>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={`reply-quoting-default-${adapterId}`} className="cursor-pointer text-sm">
            {t("label")}
          </Label>
          <Switch
            id={`reply-quoting-default-${adapterId}`}
            checked={enabled}
            onCheckedChange={toggle}
            disabled={!quoting.available}
            aria-label={t("label")}
            data-testid="reply-quoting-default-switch"
          />
        </div>
        {/* The stored value is still shown rather than forced to off: it is
         * what the row says, and it becomes live again the moment the cause is
         * fixed (a re-authorized Slack grant). The notice is what marks it
         * inert meanwhile. */}
        {!quoting.available && <CapabilityNotice availability={quoting} />}
      </CardContent>
    </Card>
  )
}
