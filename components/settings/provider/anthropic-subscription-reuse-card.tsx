"use client"

// Anthropic auth extras, relocated from the former standalone "api-key" section
// into Settings → Providers (Anthropic). Surfaces the official Pro/Max
// subscription OAuth so users who already signed in there are NOT asked to
// paste an API key again ("status-aware reuse"), preserves the `settings.ai`
// plugin slot, and keeps the privacy + CCSwitch cross-link hints. The
// subscription block is desktop-only (the vault + subscription section live in
// Tauri); the privacy note shows on every platform.

import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import { ShieldCheckIcon, SparklesIcon, KeyRoundIcon, ArrowLeftRightIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { SettingsAlert } from "@/components/settings/common/settings-section"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { isTauri } from "@/lib/tauri"
import { useActiveAnthropicCredential } from "@/lib/subscription/anthropic/hooks"

export function AnthropicSubscriptionReuseCard() {
  const t = useTranslations("providers.subscriptionReuse")
  const router = useRouter()
  const searchParams = useSearchParams()
  const { credential, loading } = useActiveAnthropicCredential()

  const goToSection = (section: "subscription" | "ccswitch") => {
    const next = new URLSearchParams(searchParams.toString())
    next.set("section", section)
    router.replace(`/settings?${next.toString()}`, { scroll: false })
  }

  const showSubscription = isTauri()

  return (
    <div className="space-y-3" data-testid="anthropic-subscription-reuse">
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

      {showSubscription && !loading && !credential && (
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
