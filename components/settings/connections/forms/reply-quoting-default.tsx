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
 * Renders nothing when the platform's adapter does not declare `send.reply`
 * — the switch would be inert there (the runtime never quotes on such
 * platforms), and an inert control is a latent bug (CLAUDE.md rule 7).
 */

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { getDb } from "@/lib/db/schema"
import { updateAdapterInstance } from "@/lib/db/adapter-instances"
import {
  effectiveCapabilitiesForRow,
  hasEffectiveCapability,
} from "@/lib/connectors/effective-capabilities"
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
  // without `chat:write` cannot reply at all, so there is nothing to configure.
  if (!hasEffectiveCapability(effectiveCapabilitiesForRow(row), "send.reply")) return null

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
            aria-label={t("label")}
            data-testid="reply-quoting-default-switch"
          />
        </div>
      </CardContent>
    </Card>
  )
}
