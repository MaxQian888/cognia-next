"use client"

// Codex Subscription → Overview tab. Top-level surface that summarises
// auth status (signed in via reuse / OAuth / nothing) and shows where the
// reused credential came from. Codex itself does not expose Anthropic-style
// 5h/7d unified rate-limit headers, so we deliberately don't pretend to
// render usage windows here.

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  CheckCircle2Icon,
  KeyRoundIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  ShieldQuestionIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  SettingsAlert,
  SettingsCard,
  SettingsEmptyState,
} from "@/components/settings/common/settings-section"

import { useCodexCredential, useCodexDiscovery } from "@/lib/codex-subscription/hooks"
import { isTauri } from "@/lib/tauri"

import { CodexSubscriptionLoginDialog } from "../login-dialog"

export function CodexSubscriptionOverviewTab() {
  const t = useTranslations("codexSubscription")
  const tabReady = isTauri()
  const { credential, isFresh } = useCodexCredential()
  const { discovered, reload: reloadDiscovery } = useCodexDiscovery()
  const [loginOpen, setLoginOpen] = useState(false)

  if (!tabReady) {
    return <SettingsAlert title={t("webModeBanner")}>{t("webModeBanner")}</SettingsAlert>
  }

  if (!credential) {
    return (
      <>
        <SettingsEmptyState
          title={t("overview.signedOutTitle")}
          description={
            discovered ? t("overview.signedOutWithDiscoveryBody") : t("overview.signedOutBody")
          }
          action={<Button onClick={() => setLoginOpen(true)}>{t("overview.signInCta")}</Button>}
        />
        <CodexSubscriptionLoginDialog
          open={loginOpen}
          onOpenChange={setLoginOpen}
          initialMode={discovered ? "reuse" : "oauth"}
        />
      </>
    )
  }

  return (
    <div className="space-y-3">
      <SettingsCard
        icon={<CheckCircle2Icon className="size-4 text-green-600" />}
        title={
          credential.authMode === "chatgpt"
            ? t("overview.signedInChatGptTitle")
            : t("overview.signedInApiKeyTitle")
        }
        description={
          credential.authMode === "chatgpt"
            ? t("overview.signedInChatGptBody")
            : t("overview.signedInApiKeyBody")
        }
        headerAction={
          <div className="flex items-center gap-2">
            <ModeBadge mode={credential.authMode} />
            <SourceBadge source={credential.originalSource ?? "oauth"} />
          </div>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          {credential.email && <KvRow label={t("account.emailLabel")} value={credential.email} />}
          {credential.chatgptPlanType && (
            <KvRow label={t("account.planLabel")} value={credential.chatgptPlanType} />
          )}
          {credential.accountId && (
            <KvRow label={t("account.accountIdLabel")} value={credential.accountId} mono />
          )}
          <KvRow
            label={t("overview.freshLabel")}
            value={isFresh ? t("overview.freshYes") : t("overview.freshNo")}
          />
        </div>
      </SettingsCard>

      {discovered && discovered.source === "file" && credential.originalSource !== "file" && (
        <SettingsAlert title={t("overview.driftWithCliTitle")}>
          {t("overview.driftWithCliBody")}{" "}
          <Button
            variant="link"
            className="h-auto p-0 text-xs"
            onClick={() => void reloadDiscovery()}
          >
            <RefreshCwIcon className="mr-1 size-3 inline" />
            {t("overview.recheck")}
          </Button>
        </SettingsAlert>
      )}
    </div>
  )
}

function ModeBadge({ mode }: { mode: "chatgpt" | "api_key" }) {
  const t = useTranslations("codexSubscription")
  const Icon = mode === "chatgpt" ? ShieldCheckIcon : KeyRoundIcon
  return (
    <Badge variant="secondary" className="text-[10px]">
      <Icon className="mr-1 size-3 inline" />
      {mode === "chatgpt" ? t("account.authMode.chatgpt") : t("account.authMode.api_key")}
    </Badge>
  )
}

function SourceBadge({ source }: { source: "file" | "keyring" | "oauth" }) {
  const t = useTranslations("codexSubscription")
  return (
    <Badge variant="outline" className="text-[10px]">
      <ShieldQuestionIcon className="mr-1 size-3 inline" />
      {t(`account.source.${source}`)}
    </Badge>
  )
}

function KvRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[100px_1fr] items-center gap-2">
      <div className="text-muted-foreground">{label}</div>
      <div className={`${mono ? "font-mono break-all" : ""}`}>{value}</div>
    </div>
  )
}
