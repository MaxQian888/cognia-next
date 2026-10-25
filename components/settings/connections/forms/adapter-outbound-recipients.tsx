"use client"

/**
 * The recipients a bot account may reach with nobody watching (ADR-0239).
 *
 * The list covers every unattended send through this account, whoever makes
 * it: a scheduled digest, a Bot, a plugin. Conversations and members only,
 * named within this account; a send to anyone else still asks, drafts or
 * parks. Saved per add and remove, unlike the trigger policy's draft: each
 * entry is a decision on its own, and a half-edited list is still a list a
 * person wrote.
 */

import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { OutboundRecipientsEditor } from "@/components/outbound/outbound-recipients-editor"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useKnownConversations } from "@/hooks/outbound/use-known-conversations"
import { setAdapterOutboundRecipients } from "@/lib/db/adapter-instances"
import { getDb } from "@/lib/db/schema"
import type { OutboundRecipientGrant } from "@cognia/agent-config-types/action-review"

const ADAPTER_KINDS = ["conversation", "person"] as const

export function AdapterOutboundRecipients({ adapterId }: { adapterId: string }) {
  const t = useTranslations("outboundRecipients")
  const row = useLiveQuery(
    async () =>
      typeof window === "undefined" ? undefined : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )
  const known = useKnownConversations(adapterId)

  const save = async (next: OutboundRecipientGrant[]): Promise<boolean> => {
    try {
      await setAdapterOutboundRecipients(adapterId, next)
      toast.success(t("saved"))
      return true
    } catch (error) {
      toast.error(
        t("saveFailed", { reason: error instanceof Error ? error.message : String(error) })
      )
      return false
    }
  }

  return (
    <Card data-testid="adapter-outbound-recipients">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("adapter.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("adapter.description")}</p>
        <OutboundRecipientsEditor
          value={row?.outboundRecipients ?? []}
          onSave={save}
          kinds={ADAPTER_KINDS}
          adapterId={adapterId}
          knownConversations={known}
          disabled={!row}
          testId="adapter-outbound-recipients-editor"
        />
      </CardContent>
    </Card>
  )
}
