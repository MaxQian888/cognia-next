"use client"

import { ArrowRightIcon, KeyRoundIcon, type LucideIcon } from "lucide-react"
import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { AnthropicAddAccountDialog } from "@/components/settings/subscription/add-account-dialog/anthropic"
import { Button } from "@/components/ui/button"
import { CodexAddAccountDialog } from "@/components/settings/subscription/add-account-dialog/codex"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { OpencodeAddAccountDialog } from "@/components/settings/subscription/add-account-dialog/opencode"
import { StepHeading } from "../step-shell"
import { loggers } from "@cognia/logging"
import { setActiveAccount } from "@/lib/subscription/core/transport"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { Account, ProviderId } from "@/types/subscription"

const log = loggers.ui.child("onboarding-provider")

type ProviderChoice = "claude" | "codex" | "opencode" | "apiKey"

interface ProviderStepProps {
  /** Called once credentials are in, so the flow can advance. */
  onConnected: () => void
}

/**
 * Step 2 — how Cognia reaches a model.
 *
 * **This step is conditional.** `resolveStepSequence` drops it entirely once
 * the user already has model access — including the case where the scan found
 * an already-authenticated `claude-code`. Asking someone with a working agent
 * CLI to go authenticate again is the kind of step that makes a first run feel
 * like paperwork.
 *
 * The four sign-in surfaces reuse the production `AddAccountDialog`s verbatim
 * rather than reimplementing OAuth here, so the credential path stays in one
 * place. That was true of the dialog this replaces and stays true.
 */
export function ProviderStep({ onConnected }: ProviderStepProps) {
  const t = useTranslations("onboarding")
  const setApiKey = useSettingsStore((s) => s.setApiKey)
  const [dialog, setDialog] = useState<ProviderChoice | null>(null)
  const [keyInput, setKeyInput] = useState("")
  const [saving, setSaving] = useState(false)

  const handleAccountAdded = async (provider: ProviderId, account: Account) => {
    try {
      await setActiveAccount(provider, account.id)
      log.info("onboarding subscription connected", { provider, accountId: account.id })
      setDialog(null)
      onConnected()
    } catch (err) {
      log.error("onboarding setActiveAccount failed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSaveKey = async () => {
    const trimmed = keyInput.trim()
    if (!trimmed) {
      toast.error(t("toastNeedKey"))
      return
    }
    setSaving(true)
    try {
      await setApiKey(trimmed)
      log.info("onboarding api key saved", { length: trimmed.length })
      onConnected()
    } catch (err) {
      log.error("onboarding api key save failed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const cards: { providerKey: ProviderChoice; icon?: LucideIcon }[] = [
    { providerKey: "claude" },
    { providerKey: "codex" },
    { providerKey: "opencode" },
    { providerKey: "apiKey", icon: KeyRoundIcon },
  ]

  return (
    <div className="flex flex-col gap-6" data-testid="onboarding-provider">
      <StepHeading title={t("provider.title")} description={t("provider.description")} />

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {cards.map(({ providerKey, icon: Icon }) => (
          <Button
            key={providerKey}
            type="button"
            variant="outline"
            onClick={() => setDialog(providerKey)}
            data-testid={`onboarding-provider-${providerKey}`}
            className="h-full w-full flex-col items-stretch justify-start gap-1 whitespace-normal p-3 text-left font-normal hover:border-primary/30 hover:shadow-md motion-safe:hover:-translate-y-0.5"
          >
            <span className="flex items-center gap-2">
              {Icon && <Icon className="size-4 text-muted-foreground" aria-hidden />}
              <span className="text-sm font-medium">{t(`provider.${providerKey}.title`)}</span>
            </span>
            <span className="line-clamp-2 text-[11px] text-muted-foreground">
              {t(`provider.${providerKey}.description`)}
            </span>
            <span className="mt-1 text-[11px] font-medium text-primary">
              {t(`provider.${providerKey}.cta`)} →
            </span>
          </Button>
        ))}
      </div>

      <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-4">
        <Label htmlFor="onboarding-key" className="text-xs">
          {t("apiKeyLabel")}
        </Label>
        <Input
          id="onboarding-key"
          type="password"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder={t("apiKeyPlaceholder")}
          className="font-mono text-xs"
        />
        <p className="text-[11px] text-muted-foreground">
          {t("apiKeyHintPrefix")}
          <code className="rounded bg-muted px-1">{t("apiKeyHintHost")}</code>
          {t("apiKeyHintSuffix")}
        </p>
        <Button
          size="sm"
          className="self-end"
          onClick={() => void handleSaveKey()}
          disabled={saving}
          data-testid="onboarding-provider-save-key"
        >
          {saving ? t("saving") : t("continue")}
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>

      <AnthropicAddAccountDialog
        open={dialog === "claude"}
        onOpenChange={(o) => {
          if (!o) setDialog(null)
        }}
        onAdded={(account) => void handleAccountAdded("anthropic", account)}
        initialMode="subscription"
      />
      <CodexAddAccountDialog
        open={dialog === "codex"}
        onOpenChange={(o) => {
          if (!o) setDialog(null)
        }}
        onAdded={(account) => void handleAccountAdded("codex", account)}
        initialMode="oauth"
      />
      <OpencodeAddAccountDialog
        open={dialog === "opencode"}
        onOpenChange={(o) => {
          if (!o) setDialog(null)
        }}
        onAdded={(account) => void handleAccountAdded("opencode", account)}
      />
    </div>
  )
}
