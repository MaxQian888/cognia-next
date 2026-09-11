"use client"

// Anthropic auth extras, relocated from the former standalone "api-key" section
// into Settings → Providers (Anthropic). Surfaces the official Pro/Max
// subscription OAuth so users who already signed in there are NOT asked to
// paste an API key again ("status-aware reuse"), preserves the `settings.ai`
// plugin slot, and keeps the privacy + CCSwitch cross-link hints. The
// subscription block is desktop-only (the vault + subscription section live in
// Tauri); the privacy note shows on every platform.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import {
  ShieldCheckIcon,
  SparklesIcon,
  KeyRoundIcon,
  ArrowLeftRightIcon,
  Loader2Icon,
  DownloadIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { SettingsAlert } from "@/components/settings/common/settings-section"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { isTauri } from "@/lib/tauri"
import {
  useActiveAnthropicCredential,
  useAnthropicDiscovery,
} from "@/lib/subscription/anthropic/hooks"
import { discoveredToCredential } from "@/lib/subscription/anthropic/discovery"
import { setActiveAccount } from "@/lib/subscription/core/transport"
import { AnthropicAddAccountDialog } from "@/components/settings/subscription/add-account-dialog/anthropic"
import type { Account } from "@/types/subscription"

export function AnthropicSubscriptionReuseCard() {
  const t = useTranslations("providers.subscriptionReuse")
  const router = useRouter()
  const searchParams = useSearchParams()
  const { credential, loading, reload } = useActiveAnthropicCredential()
  // Only probe Claude Code's own keychain item (a separate macOS keychain
  // prompt) while we might actually offer the one-click reuse — i.e. once we
  // know there is no active credential. Skipping it when signed in (or still
  // resolving) avoids a redundant password prompt whose result would be
  // discarded by the `!credential` guards below.
  const { discovered } = useAnthropicDiscovery({ enabled: !loading && !credential })
  const [dialogOpen, setDialogOpen] = useState(false)
  const [adopting, setAdopting] = useState(false)
  const [adoptError, setAdoptError] = useState<string | null>(null)

  const goToSection = (section: "subscription" | "ccswitch") => {
    const next = new URLSearchParams(searchParams.toString())
    next.set("section", section)
    if (section === "subscription") {
      next.set("subTab", "accounts")
      next.delete("innerTab")
    }
    router.replace(`/settings?${next.toString()}`, { scroll: false })
  }

  // Creation stays in the shared dialog so endpoint binding is available here too.
  const onAccountAdded = async (account: Account) => {
    setAdopting(true)
    setAdoptError(null)
    try {
      await setActiveAccount("anthropic", account.id)
      await reload()
    } catch (e) {
      setAdoptError(e instanceof Error ? e.message : String(e))
    } finally {
      setAdopting(false)
    }
  }

  const showSubscription = isTauri()
  const localLoginAdoptable = !!discovered && !!discoveredToCredential(discovered)

  return (
    <div className="space-y-3" data-testid="anthropic-subscription-reuse">
      {showSubscription && dialogOpen && (
        <AnthropicAddAccountDialog
          open
          initialMode="reuse"
          onOpenChange={setDialogOpen}
          onAdded={(account) => void onAccountAdded(account)}
        />
      )}
      {/* ADR-0026 §5 §B — revived `settings.ai` slot (moved from api-key). */}
      <PluginExtensionSlot point="settings.ai" className="empty:hidden" />

      {showSubscription && !loading && credential && (
        <SettingsAlert
          icon={<ShieldCheckIcon className="size-4" />}
          title={t("signedInTitle")}
          action={
            <Button variant="outline" size="sm" onClick={() => goToSection("subscription")}>
              {t("manage")}
            </Button>
          }
        >
          <p>
            {credential.plan
              ? t("signedInBodyPlan", {
                  account: credential.email ?? credential.mode,
                  plan: credential.plan,
                })
              : t("signedInBody", { account: credential.email ?? credential.mode })}
          </p>
          <p className="mt-1 text-muted-foreground">{t("keyOptional")}</p>
        </SettingsAlert>
      )}

      {showSubscription && !loading && !credential && localLoginAdoptable && (
        <SettingsAlert
          icon={<DownloadIcon className="size-4" />}
          title={t("localLoginTitle")}
          action={
            <Button
              variant="outline"
              size="sm"
              disabled={adopting}
              onClick={() => setDialogOpen(true)}
            >
              {adopting && <Loader2Icon className="mr-2 size-4 animate-spin" />}
              {t("localLoginAction")}
            </Button>
          }
        >
          <p>
            {discovered?.subscriptionType
              ? t("localLoginBodyPlan", { plan: discovered.subscriptionType })
              : t("localLoginBody")}
          </p>
          {adoptError && <p className="mt-1 text-destructive">{adoptError}</p>}
        </SettingsAlert>
      )}

      {showSubscription && !loading && !credential && !localLoginAdoptable && (
        <SettingsAlert
          icon={<SparklesIcon className="size-4" />}
          title={t("signedOutTitle")}
          action={
            <Button variant="outline" size="sm" onClick={() => goToSection("subscription")}>
              {t("signIn")}
            </Button>
          }
        >
          {t("signedOutBody")}
        </SettingsAlert>
      )}

      <SettingsAlert icon={<KeyRoundIcon className="size-4" />} title={t("privacyTitle")}>
        {t("privacyBody")}
      </SettingsAlert>

      {showSubscription && (
        <SettingsAlert
          icon={<ArrowLeftRightIcon className="size-4" />}
          title={t("ccswitchHintTitle")}
          action={
            <Button variant="outline" size="sm" onClick={() => goToSection("ccswitch")}>
              {t("ccswitchHintAction")}
            </Button>
          }
        >
          {t("ccswitchHintBody")}
        </SettingsAlert>
      )}
    </div>
  )
}
