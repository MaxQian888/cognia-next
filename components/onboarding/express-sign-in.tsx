"use client"

import { CheckIcon } from "lucide-react"
import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { AnthropicAddAccountDialog } from "@/components/settings/subscription/add-account-dialog/anthropic"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Label } from "@/components/ui/label"
import { ProviderStep } from "./steps/provider-step"
import {
  connectSubscriptionAccount,
  saveBuiltInProviderKey,
} from "@/lib/onboarding/connect-provider"
import { isStandaloneChatMode } from "@/lib/runtime/standalone-mode"
import { loggers } from "@cognia/logging"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { Account } from "@/types/subscription"

const log = loggers.ui.child("onboarding-express-sign-in")

/** The provider the collapsed form configures, and the app's own default. */
const DEFAULT_PROVIDER = "anthropic"

interface ExpressSignInProps {
  /** Fired once a credential is in and persisted. */
  onConnected?: () => void
}

/**
 * The recommended path's inline sign-in — the one thing on that screen that
 * cannot be automated.
 *
 * OAuth, a device code and a pasted key all need a human, so "recommended" can
 * never mean "zero interaction" here. What it can mean is *one* interaction,
 * in place, without leaving the screen: this renders the single most likely
 * option for the shell and nothing else, with the full catalogue one
 * disclosure away.
 *
 * **Which option is "most likely" is a property of the shell, not a guess.**
 * Subscription accounts live in the OS keyring and resolve through
 * `resolveAccountEnv`, which returns nothing in standalone mode. So a desktop
 * gets the Anthropic subscription button, and a browser or BYOK phone gets a
 * key field — offering the other one would be offering something that shell
 * cannot use, which is how the previous flow let an entire browser onboarding
 * complete without producing a usable credential.
 *
 * **The disclosure is the real sign-in step, not a copy of it.** Expanding it
 * mounts `ProviderStep` with its heading suppressed: all three subscription
 * dialogs, the 77-provider catalogue, the same readiness validation. A second
 * cut-down provider picker living here is exactly the drift this avoids.
 */
export function ExpressSignIn({ onConnected }: ExpressSignInProps) {
  const t = useTranslations("onboarding")
  const setApiKey = useSettingsStore((s) => s.setApiKey)
  const setProviderConfig = useSettingsStore((s) => s.setProviderConfig)
  const setDefaultProvider = useSettingsStore((s) => s.setDefaultProvider)

  const [expanded, setExpanded] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [keyInput, setKeyInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [connected, setConnected] = useState<string | null>(null)

  // Read at render rather than through a hook: the value only changes with
  // `mobileRuntimeMode`, which the welcome step commits and which re-renders
  // the whole flow. Same rule the sign-in step follows.
  const standalone = isStandaloneChatMode()

  const finish = (label: string) => {
    setConnected(label)
    setDialogOpen(false)
    setExpanded(false)
    onConnected?.()
  }

  const handleAccountAdded = async (account: Account) => {
    setBusy(true)
    try {
      const summary = await connectSubscriptionAccount({ account, setDefaultProvider })
      log.info("express subscription connected", {
        provider: summary.provider,
        accountId: account.id,
      })
      finish(summary.email ?? summary.provider)
    } catch (err) {
      log.error("express subscription activation failed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleSaveKey = async () => {
    setBusy(true)
    try {
      const result = await saveBuiltInProviderKey({
        draft: {
          providerId: DEFAULT_PROVIDER,
          apiKey: keyInput,
          baseURL: "",
          requiresCredential: true,
          requiresBaseUrl: false,
        },
        setProviderConfig,
        setDefaultProvider,
        setApiKey,
      })
      if (!result.ok) {
        toast.error(t("toastNeedKey"))
        return
      }
      log.info("express provider key saved", { length: keyInput.trim().length })
      finish(t("provider.apiKey.title"))
    } catch (err) {
      log.error("express provider key save failed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (connected) {
    return (
      <div
        className="flex items-center gap-2 text-xs text-muted-foreground"
        data-testid="onboarding-express-connected"
      >
        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-brand-action/20">
          <CheckIcon className="size-2.5 text-foreground" aria-hidden />
        </span>
        {t("express.signIn.connected", { account: connected })}
      </div>
    )
  }

  if (expanded) {
    return (
      <div className="flex flex-col gap-3" data-testid="onboarding-express-sign-in-expanded">
        <ProviderStep heading={false} onConnected={() => finish(t("provider.loggedInBadge"))} />
        <Button
          variant="link"
          size="sm"
          className="h-auto self-start p-0 text-xs text-muted-foreground"
          onClick={() => setExpanded(false)}
          data-testid="onboarding-express-sign-in-collapse"
        >
          {t("express.signIn.collapse")}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2.5" data-testid="onboarding-express-sign-in">
      {standalone ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="express-key" className="text-xs font-medium">
            {t("apiKeyLabel")}
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="express-key"
              type="password"
              value={keyInput}
              onChange={(event) => setKeyInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !busy) void handleSaveKey()
              }}
              placeholder={t("apiKeyPlaceholder")}
              className="h-9 max-w-[22rem] flex-1 font-mono text-xs"
              data-testid="onboarding-express-key"
            />
            <Button
              size="sm"
              disabled={busy || keyInput.trim().length === 0}
              onClick={() => void handleSaveKey()}
              data-testid="onboarding-express-key-save"
            >
              {busy && <Spinner className="size-3.5" />}
              {t("express.signIn.save")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <Button
            size="sm"
            className="self-start"
            disabled={busy}
            onClick={() => setDialogOpen(true)}
            data-testid="onboarding-express-sign-in-primary"
          >
            {busy && <Spinner className="size-3.5" />}
            {t("provider.claude.cta")}
          </Button>
          {/* No `initialMode`: the dialog defaults to `reuse` when it finds an
              existing Claude Code login, which is precisely the machine the
              plan above is describing. Forcing `subscription` would send that
              user through a full browser PKCE round-trip. */}
          <AnthropicAddAccountDialog
            open={dialogOpen}
            onOpenChange={(open) => {
              if (!open) setDialogOpen(false)
            }}
            onAdded={(account) => void handleAccountAdded(account)}
          />
        </>
      )}

      <Button
        variant="link"
        size="sm"
        className="h-auto self-start p-0 text-xs text-muted-foreground"
        onClick={() => setExpanded(true)}
        data-testid="onboarding-express-sign-in-more"
      >
        {t("express.signIn.more")}
      </Button>
    </div>
  )
}
