"use client"

// Codex Subscription → Usage tab. Codex / OpenAI don't expose unified
// rate-limit headers like Anthropic does, so we don't pretend to render a
// usage timeline here. The tab is a deliberate "not supported" surface
// plus the audit-facing fields (where the discovered credential lives on
// disk, when it was last refreshed).

import { useTranslations } from "next-intl"
import { InfoIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { SettingsAlert, SettingsCard } from "@/components/settings/common/settings-section"

import { useCodexCredential, useCodexDiscovery } from "@/lib/codex-subscription/hooks"
import { isTauri } from "@/lib/tauri"

export function CodexSubscriptionUsageTab() {
  const t = useTranslations("codexSubscription")
  const tabReady = isTauri()
  const { credential } = useCodexCredential()
  const { discovered, error } = useCodexDiscovery()

  if (!tabReady) {
    return <SettingsAlert title={t("webModeBanner")}>{t("webModeBanner")}</SettingsAlert>
  }

  return (
    <div className="space-y-3">
      <SettingsAlert icon={<InfoIcon className="size-4" />} title={t("usage.unsupportedTitle")}>
        {t("usage.unsupportedBody")}
      </SettingsAlert>

      <SettingsCard title={t("usage.auditTitle")} description={t("usage.auditBody")}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <KvRow
            label={t("usage.credentialMode")}
            value={
              credential
                ? credential.authMode === "chatgpt"
                  ? t("account.authMode.chatgpt")
                  : t("account.authMode.api_key")
                : "—"
            }
          />
          <KvRow
            label={t("usage.credentialSource")}
            value={credential ? t(`account.source.${credential.originalSource ?? "oauth"}`) : "—"}
          />
          <KvRow label={t("usage.discoveryPath")} value={discovered?.authJsonPath ?? "—"} mono />
          <KvRow
            label={t("usage.discoverySource")}
            value={discovered ? t(`account.source.${discovered.source}`) : "—"}
          />
          <KvRow
            label={t("usage.lastRefreshLabel")}
            value={
              discovered?.lastRefreshIso ??
              (credential?.storedAtMs ? new Date(credential.storedAtMs).toLocaleString() : "—")
            }
          />
          {error && <KvRow label={t("usage.discoveryError")} value={error} mono />}
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          <Badge variant="outline" className="mr-1 text-[10px]">
            FYI
          </Badge>
          {t("usage.openaiRoadmapHint")}
        </p>
      </SettingsCard>
    </div>
  )
}

function KvRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-center gap-2">
      <div className="text-muted-foreground">{label}</div>
      <div className={`${mono ? "font-mono break-all" : ""}`}>{value}</div>
    </div>
  )
}
