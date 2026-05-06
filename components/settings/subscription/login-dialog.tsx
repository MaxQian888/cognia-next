"use client"

// Two-step Claude OAuth login. Step 1 opens the authorize URL in the user's
// browser; step 2 accepts the code (or full callback URL) the user pastes
// back from the redirect page. PKCE state lives in component state — there's
// no need for global storage as the dialog is short-lived.

import { useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ExternalLinkIcon, Loader2Icon, ShieldCheckIcon, ShieldQuestionIcon } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"

import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  extractAuthorizationCode,
  type OAuthFlowState,
} from "@/lib/anthropic-subscription/oauth"
import { saveCredential } from "@/lib/anthropic-subscription/credential-store"
import type { OAuthMode, SubscriptionCredential } from "@/lib/anthropic-subscription/types"
import { openUrl } from "@/lib/native/opener"

export interface SubscriptionLoginDialogProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  onLoggedIn?: (credential: SubscriptionCredential) => void
  /** Default mode shown when the dialog opens. */
  initialMode?: OAuthMode
}

type Step = "choose-mode" | "awaiting-code" | "exchanging" | "done"

export function SubscriptionLoginDialog({
  open,
  onOpenChange,
  onLoggedIn,
  initialMode = "subscription",
}: SubscriptionLoginDialogProps) {
  const t = useTranslations("subscription")

  const [mode, setMode] = useState<OAuthMode>(initialMode)
  const [step, setStep] = useState<Step>("choose-mode")
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null)
  const [codeInput, setCodeInput] = useState("")
  const [error, setError] = useState<string | null>(null)
  const flowStateRef = useRef<OAuthFlowState | null>(null)

  // Reset every time the dialog re-opens. Derived-state-from-prop pattern —
  // see https://react.dev/reference/react/useState#storing-information-from-previous-renders.
  // The `flowStateRef` reset moves to `onStartFlow` (the only place it's
  // also written) so render stays free of ref mutations.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setMode(initialMode)
      setStep("choose-mode")
      setAuthorizeUrl(null)
      setCodeInput("")
      setError(null)
    }
  }

  const stepDescription = useMemo(() => {
    switch (step) {
      case "choose-mode":
        return t("login.chooseMode")
      case "awaiting-code":
        return t("login.awaitingCode")
      case "exchanging":
        return t("login.exchanging")
      case "done":
        return t("login.done")
    }
  }, [step, t])

  const onStartFlow = async () => {
    setError(null)
    try {
      const result = await buildAuthorizeUrl({ mode })
      flowStateRef.current = result.flowState
      setAuthorizeUrl(result.url)
      setStep("awaiting-code")
      // Best-effort: open immediately. The user can also click the link
      // we render in step 2 if their popup blocker eats this.
      void openUrl(result.url)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const onExchange = async () => {
    const flowState = flowStateRef.current
    if (!flowState) {
      setError(t("login.errors.flowStateMissing"))
      return
    }
    const extracted = extractAuthorizationCode(codeInput)
    if (!extracted) {
      setError(t("login.errors.codeMalformed"))
      return
    }
    if (extracted.state && extracted.state !== flowState.state) {
      setError(t("login.errors.stateMismatch"))
      return
    }
    setError(null)
    setStep("exchanging")
    try {
      const credential = await exchangeCodeForTokens({
        code: extracted.code,
        flowState,
      })
      await saveCredential(credential)
      setStep("done")
      onLoggedIn?.(credential)
      // Auto-close after a brief moment so the user sees the success.
      window.setTimeout(() => onOpenChange(false), 800)
    } catch (e) {
      setStep("awaiting-code")
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheckIcon className="size-4" />
            {t("login.title")}
          </DialogTitle>
          <DialogDescription>{stepDescription}</DialogDescription>
        </DialogHeader>

        {step === "choose-mode" && (
          <div className="space-y-4 py-2">
            <RadioGroup
              value={mode}
              onValueChange={(value) => setMode(value as OAuthMode)}
              aria-label={t("login.modeGroupLabel")}
            >
              <Label
                htmlFor="mode-subscription"
                className="flex cursor-pointer items-start gap-3 rounded-md border p-3"
              >
                <RadioGroupItem id="mode-subscription" value="subscription" className="mt-0.5" />
                <div className="space-y-1">
                  <div className="font-medium">{t("login.modes.subscription.label")}</div>
                  <div className="text-xs text-muted-foreground">
                    {t("login.modes.subscription.description")}
                  </div>
                </div>
              </Label>
              <Label
                htmlFor="mode-console"
                className="flex cursor-pointer items-start gap-3 rounded-md border p-3"
              >
                <RadioGroupItem id="mode-console" value="console" className="mt-0.5" />
                <div className="space-y-1">
                  <div className="font-medium">{t("login.modes.console.label")}</div>
                  <div className="text-xs text-muted-foreground">
                    {t("login.modes.console.description")}
                  </div>
                </div>
              </Label>
            </RadioGroup>
          </div>
        )}

        {step === "awaiting-code" && authorizeUrl && (
          <div className="space-y-3 py-2">
            <p className="text-xs text-muted-foreground">{t("login.pasteHint")}</p>
            <Button asChild variant="outline" size="sm">
              <a
                href={authorizeUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1"
              >
                <ExternalLinkIcon className="size-3.5" />
                {t("login.reopenLink")}
              </a>
            </Button>
            <div className="space-y-2">
              <Label htmlFor="code-input">{t("login.codeFieldLabel")}</Label>
              <Textarea
                id="code-input"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
                placeholder={t("login.codeFieldPlaceholder")}
                rows={4}
                spellCheck={false}
                autoFocus
              />
            </div>
          </div>
        )}

        {step === "exchanging" && (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            {t("login.exchanging")}
          </div>
        )}

        {step === "done" && (
          <div className="flex items-center gap-2 py-4 text-sm">
            <ShieldCheckIcon className="size-4 text-green-600" />
            {t("login.done")}
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
            <ShieldQuestionIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <DialogFooter>
          {step === "choose-mode" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("login.actions.cancel")}
              </Button>
              <Button onClick={onStartFlow}>{t("login.actions.openAuthorize")}</Button>
            </>
          )}
          {step === "awaiting-code" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("login.actions.cancel")}
              </Button>
              <Button onClick={onExchange} disabled={!codeInput.trim()}>
                {t("login.actions.signIn")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
