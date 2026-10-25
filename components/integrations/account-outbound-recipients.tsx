"use client"

/**
 * The repositories a GitHub integration account may write to with nobody
 * watching (ADR-0239 phase 2, `integration-account:<id>`).
 *
 * The list covers every unattended GitHub write through this account,
 * whoever makes it: a workflow step, a plugin, a scheduled run's tool call,
 * and (since a `gh` command names no account) an unattended `gh` write to a
 * repository on it. A write to any other repository still waits for a
 * person. A Bot's writes have the Bot's own list, in the Bot console.
 *
 * Only a person writes it, here; the plugin API neither shows nor takes it.
 * Saved per add and remove, like the bot-account list.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { OutboundRecipientsEditor } from "@/components/outbound/outbound-recipients-editor"
import { useKnownRepositories } from "@/hooks/outbound/use-known-repositories"
import type { IntegrationAccountRow } from "@/lib/db/integration-types"
import { setIntegrationAccountOutboundRecipients } from "@/lib/db/integrations"
import type { OutboundRecipientGrant } from "@cognia/agent-config-types/action-review"

const ACCOUNT_KINDS = ["repository"] as const

/** The account's web host, for a typed `owner/repo`. */
async function accountWebHost(
  account: Pick<IntegrationAccountRow, "providerId" | "authSessionId">
): Promise<string> {
  const [{ integrationApiBaseUrl }, { githubWebHost }] = await Promise.all([
    import("@/lib/integrations/action-runner"),
    import("@/lib/policy/action-review/github-targets"),
  ])
  return githubWebHost(await integrationApiBaseUrl(account))
}

export function IntegrationAccountOutboundRecipients({
  account,
}: {
  account: Pick<
    IntegrationAccountRow,
    "id" | "pluginId" | "providerId" | "authSessionId" | "outboundRecipients"
  >
}) {
  const t = useTranslations("outboundRecipients")
  const known = useKnownRepositories(account.id)
  const [host, setHost] = useState<string>()

  useEffect(() => {
    let cancelled = false
    void accountWebHost(account)
      .then((resolved) => {
        if (!cancelled) setHost(resolved)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // The host follows the account's credentials, not its list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.providerId, account.authSessionId])

  const save = async (next: OutboundRecipientGrant[]): Promise<boolean> => {
    try {
      await setIntegrationAccountOutboundRecipients(account.pluginId, account.id, next)
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
    <div
      className="space-y-2 border-t pt-2"
      data-testid={`integration-account-outbound-recipients-${account.id}`}
    >
      <p className="text-xs font-medium">{t("integrationAccount.title")}</p>
      <p className="text-xs text-muted-foreground">{t("integrationAccount.description")}</p>
      <OutboundRecipientsEditor
        value={account.outboundRecipients ?? []}
        onSave={save}
        kinds={ACCOUNT_KINDS}
        knownConversations={[]}
        knownRepositories={known}
        {...(host ? { repositoryHost: host } : {})}
        testId={`integration-account-outbound-recipients-editor-${account.id}`}
      />
    </div>
  )
}
