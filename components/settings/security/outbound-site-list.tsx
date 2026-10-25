"use client"

/**
 * The global site list (ADR-0239 phase 2b): the sites any browser submission
 * may reach with nobody asking, whichever run makes it.
 *
 * Stored as `agentPermissions.outboundSites` and written only here, as the
 * person's own edit, through the same editor as the other recipient lists, so
 * a typed URL is listed as its origin. A Bot installation's own list may hold
 * sites too; this one covers every run.
 *
 * Intentionally dormant until the browser chokepoints land (phase 2b WP12):
 * nothing plans a browser submission yet, so the list changes nothing. The
 * section says so, pinned by `outbound-site-list.test.tsx`. Like the rest of
 * the Security card, it edits nothing while this shell drives a paired Host,
 * where the list that counts lives.
 */

import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { OutboundRecipientsEditor } from "@/components/outbound/outbound-recipients-editor"
import { readOutboundSiteGrants } from "@/lib/policy/action-review/configured-grants"
import { useSettingsStore } from "@/stores/settings"
import {
  validateOutboundRecipientGrants,
  type OutboundRecipientGrant,
} from "@cognia/agent-config-types/action-review"

const SITE_KINDS = ["site"] as const

export function OutboundSiteList({ disabled = false }: { disabled?: boolean }) {
  const t = useTranslations("settings.security.outboundAuthorization.sites")
  const tRecipients = useTranslations("outboundRecipients")
  const settings = useSettingsStore((s) => s.settings)
  const saveSettings = useSettingsStore((s) => s.save)

  const save = async (next: OutboundRecipientGrant[]): Promise<boolean> => {
    try {
      const errors = validateOutboundRecipientGrants(next)
      if (errors.length > 0) throw new Error(errors.join("; "))
      // Read the latest permissions, so a mode switch saved meanwhile is kept.
      const permissions = useSettingsStore.getState().settings?.agentPermissions ?? {}
      await saveSettings({ agentPermissions: { ...permissions, outboundSites: next } })
      toast.success(tRecipients("saved"))
      return true
    } catch (error) {
      toast.error(
        tRecipients("saveFailed", {
          reason: error instanceof Error ? error.message : String(error),
        })
      )
      return false
    }
  }

  return (
    <section className="space-y-3" data-testid="outbound-site-list">
      <div className="space-y-1">
        <h4 className="text-sm font-medium">{t("title")}</h4>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
        <p className="text-xs text-muted-foreground" data-testid="outbound-site-list-dormant">
          {t("dormant")}
        </p>
      </div>
      <OutboundRecipientsEditor
        value={readOutboundSiteGrants(settings)}
        onSave={save}
        kinds={SITE_KINDS}
        knownConversations={[]}
        disabled={disabled || !settings}
        testId="outbound-site-list-editor"
      />
    </section>
  )
}
