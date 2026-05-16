"use client"

// Codex login dialog — two modes:
//
//   • Reuse — when `~/.codex/auth.json` (or codex-cli's keyring entry)
//     already holds a valid credential, one click copies it into cognia's
//     own keyring. We never write back to codex-cli's source files.
//
//   • OAuth — device-code flow against `auth.openai.com`. Renders the
//     `user_code` + `verification_uri` so the user can complete sign-in
//     in their browser (typically a phone-friendly auth.openai.com page).

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  CopyIcon,
  ExternalLinkIcon,
  Loader2Icon,
  RefreshCwIcon,
  ShieldCheckIcon,
  ShieldQuestionIcon,
} from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Separator } from "@/components/ui/separator"

import { saveCodexCredential } from "@/lib/codex-subscription/credential-store"
import { discoveredToCredential } from "@/lib/codex-subscription/discovery"
import {
  deadlineMsFromResponse,
  intervalMsFromResponse,
  pendingIsTerminal,
  pollCodexDeviceCode,
  pollOutcomeKind,
  pollOutcomePayload,
  requestCodexDeviceCode,
  tokenResponseToCredential,
} from "@/lib/codex-subscription/oauth"
import type {
  CodexCredential,
  DeviceCodePendingPayload,
  DeviceCodeResponse,
  DiscoveredCodexAuth,
  TokenResponse,
} from "@/lib/codex-subscription/types"
import { useCodexDiscovery } from "@/lib/codex-subscription/hooks"
import { openUrl } from "@/lib/native/opener"

export type CodexLoginMode = "reuse" | "oauth"

export interface CodexSubscriptionLoginDialogProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  onLoggedIn?: (credential: CodexCredential) => void
  /** Default mode shown when the dialog opens. */
  initialMode?: CodexLoginMode
}

type OAuthStep = "request" | "awaiting" | "exchanging" | "done"

export function CodexSubscriptionLoginDialog({
  open,
  onOpenChange,
  onLoggedIn,
  initialMode,
}: CodexSubscriptionLoginDialogProps) {
  const t = useTranslations("codexSubscription")

  const { discovered, loading: discoveryLoading, reload: reloadDiscovery } = useCodexDiscovery()

  // Default to "reuse" when discovery found something; otherwise "oauth".
  const computedDefault: CodexLoginMode = useMemo(() => {
    if (initialMode) return initialMode
    return discovered ? "reuse" : "oauth"
  }, [initialMode, discovered])

  const [mode, setMode] = useState<CodexLoginMode>(computedDefault)
  // Re-sync mode when the dialog opens or when discovery completes while
  // the dialog is open. The `[prevOpen, prevComputedDefault]` derived-state
  // pattern keeps the work synchronous, avoiding the legacy useEffect that
  // tripped `react-hooks/set-state-in-effect` (React 19 rule).
  const [prevOpen, setPrevOpen] = useState(open)
  const [prevComputedDefault, setPrevComputedDefault] = useState(computedDefault)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) setMode(computedDefault)
    setPrevComputedDefault(computedDefault)
  } else if (open && computedDefault !== prevComputedDefault) {
    setPrevComputedDefault(computedDefault)
    setMode(computedDefault)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("login.title")}</DialogTitle>
          <DialogDescription>{t("login.chooseMode")}</DialogDescription>
        </DialogHeader>

        <RadioGroup
          value={mode}
          onValueChange={(v) => setMode(v as CodexLoginMode)}
          className="grid gap-2"
        >
          <ModeRow
            id="reuse"
            value="reuse"
            icon={<ShieldCheckIcon className="size-4" />}
            title={t("login.modes.reuse.label")}
            description={t("login.modes.reuse.description")}
            disabled={!discovered}
          />
          <ModeRow
            id="oauth"
            value="oauth"
            icon={<ShieldQuestionIcon className="size-4" />}
            title={t("login.modes.oauth.label")}
            description={t("login.modes.oauth.description")}
          />
        </RadioGroup>

        <Separator />

        {mode === "reuse" ? (
          <ReusePanel
            discovered={discovered}
            loading={discoveryLoading}
            onReload={reloadDiscovery}
            onAdopt={async (next) => {
              await saveCodexCredential(next)
              onLoggedIn?.(next)
              onOpenChange(false)
            }}
          />
        ) : (
          <OAuthPanel
            onCompleted={async (response) => {
              const next = tokenResponseToCredential(response, {
                authMode: "chatgpt",
              })
              await saveCodexCredential(next)
              onLoggedIn?.(next)
              onOpenChange(false)
            }}
          />
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("login.actions.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ModeRow({
  id,
  value,
  icon,
  title,
  description,
  disabled,
}: {
  id: string
  value: CodexLoginMode
  icon: React.ReactNode
  title: string
  description: string
  disabled?: boolean
}) {
  return (
    <label
      htmlFor={id}
      className={`flex items-start gap-3 rounded border px-3 py-2 ${
        disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:bg-muted/30"
      }`}
    >
      <RadioGroupItem value={value} id={id} disabled={disabled} className="mt-1" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          {icon}
          {title}
        </div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </label>
  )
}

function ReusePanel({
  discovered,
  loading,
  onReload,
  onAdopt,
}: {
  discovered: DiscoveredCodexAuth | null
  loading: boolean
  onReload: () => Promise<void>
  onAdopt: (credential: CodexCredential) => Promise<void>
}) {
  const t = useTranslations("codexSubscription")
  const [adopting, setAdopting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const credentialPreview = useMemo(
    () => (discovered ? discoveredToCredential(discovered) : null),
    [discovered]
  )

  if (loading) {
    return (
      <p className="text-sm text-muted-foreground">
        <Loader2Icon className="mr-2 inline size-4 animate-spin" />
        {t("login.reuse.scanning")}
      </p>
    )
  }

  if (!discovered) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{t("login.reuse.nothingFound")}</p>
        <Button variant="outline" size="sm" onClick={() => void onReload()}>
          <RefreshCwIcon className="mr-2 size-4" />
          {t("login.reuse.rescan")}
        </Button>
      </div>
    )
  }

  const canAdopt = !!credentialPreview

  return (
    <div className="space-y-3 text-sm">
      <div className="rounded border bg-muted/30 px-3 py-2 space-y-1">
        <KvRow label={t("login.reuse.source")} value={discovered.source} />
        <KvRow label={t("login.reuse.authJsonPath")} value={discovered.authJsonPath} mono />
        {discovered.authMode && (
          <KvRow label={t("login.reuse.authMode")} value={discovered.authMode} />
        )}
        {discovered.tokens?.email && (
          <KvRow label={t("login.reuse.email")} value={discovered.tokens.email} />
        )}
        {discovered.tokens?.chatgptPlanType && (
          <KvRow label={t("login.reuse.plan")} value={discovered.tokens.chatgptPlanType} />
        )}
      </div>

      {!canAdopt && <p className="text-xs text-destructive">{t("login.reuse.notAdoptable")}</p>}

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" size="sm" onClick={() => void onReload()}>
          <RefreshCwIcon className="mr-2 size-4" />
          {t("login.reuse.rescan")}
        </Button>
        <Button
          size="sm"
          disabled={!canAdopt || adopting}
          onClick={async () => {
            if (!credentialPreview) return
            setAdopting(true)
            setError(null)
            try {
              await onAdopt(credentialPreview)
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            } finally {
              setAdopting(false)
            }
          }}
        >
          {adopting && <Loader2Icon className="mr-2 size-4 animate-spin" />}
          {t("login.reuse.adopt")}
        </Button>
      </div>
    </div>
  )
}

function OAuthPanel({ onCompleted }: { onCompleted: (response: TokenResponse) => Promise<void> }) {
  const t = useTranslations("codexSubscription")
  const [step, setStep] = useState<OAuthStep>("request")
  const [device, setDevice] = useState<DeviceCodeResponse | null>(null)
  const [pending, setPending] = useState<DeviceCodePendingPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelledRef = useRef(false)

  useEffect(() => {
    cancelledRef.current = false
    return () => {
      cancelledRef.current = true
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current)
      }
    }
  }, [])

  const onStart = async () => {
    setError(null)
    setPending(null)
    try {
      const res = await requestCodexDeviceCode()
      setDevice(res)
      setStep("awaiting")
      // Best-effort: open the verification page automatically.
      const url = res.verification_uri_complete ?? res.verification_uri
      if (url) void openUrl(url)
      void pollLoop(res)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const pollLoop = async (res: DeviceCodeResponse) => {
    const intervalMs = intervalMsFromResponse(res)
    const deadlineMs = deadlineMsFromResponse(res)
    let currentInterval = intervalMs
    const tick = async () => {
      if (cancelledRef.current) return
      if (Date.now() > deadlineMs) {
        setPending({ error: "expired_token" })
        return
      }
      try {
        const outcome = await pollCodexDeviceCode(res.device_code)
        if (cancelledRef.current) return
        if (pollOutcomeKind(outcome) === "granted") {
          setStep("exchanging")
          await onCompleted(pollOutcomePayload(outcome) as TokenResponse)
          setStep("done")
          return
        }
        const p = pollOutcomePayload(outcome) as DeviceCodePendingPayload
        setPending(p)
        if (pendingIsTerminal(p)) {
          return
        }
        // `slow_down` asks us to wait longer next time.
        if (p.error === "slow_down") {
          currentInterval = Math.min(currentInterval * 2, 60_000)
        }
        pollTimerRef.current = setTimeout(() => void tick(), currentInterval)
      } catch (e) {
        if (cancelledRef.current) return
        setError(e instanceof Error ? e.message : String(e))
      }
    }
    pollTimerRef.current = setTimeout(() => void tick(), currentInterval)
  }

  if (step === "request") {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{t("login.oauth.intro")}</p>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button size="sm" onClick={() => void onStart()}>
          {t("login.oauth.start")}
        </Button>
      </div>
    )
  }

  if (step === "awaiting" && device) {
    const url = device.verification_uri_complete ?? device.verification_uri
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{t("login.oauth.awaiting")}</p>
        <div className="rounded border bg-muted/30 px-3 py-2 space-y-2">
          <KvRow label={t("login.oauth.userCode")} value={device.user_code} mono>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (typeof navigator !== "undefined" && navigator.clipboard) {
                  void navigator.clipboard.writeText(device.user_code)
                }
              }}
              aria-label={t("login.oauth.copy")}
              className="h-6 px-2"
            >
              <CopyIcon className="size-3" />
            </Button>
          </KvRow>
          <KvRow label={t("login.oauth.verificationUri")} value={url} mono>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void openUrl(url)}
              aria-label={t("login.oauth.openLink")}
              className="h-6 px-2"
            >
              <ExternalLinkIcon className="size-3" />
            </Button>
          </KvRow>
        </div>
        {pending && (
          <Badge variant="outline" className="text-[10px]">
            {pendingLabelFor(pending.error, t)}
          </Badge>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    )
  }

  if (step === "exchanging") {
    return (
      <p className="text-sm text-muted-foreground">
        <Loader2Icon className="mr-2 inline size-4 animate-spin" />
        {t("login.oauth.exchanging")}
      </p>
    )
  }

  return <p className="text-sm text-muted-foreground">{t("login.oauth.done")}</p>
}

/**
 * Map the four OAuth-spec pending codes onto translated labels. Unknown
 * codes fall through to the raw `error` string so the user still has a
 * (non-translated) clue rather than a blank badge.
 */
function pendingLabelFor(
  errorCode: string,
  t: ReturnType<typeof useTranslations<"codexSubscription">>
): string {
  switch (errorCode) {
    case "authorization_pending":
      return t("login.oauth.pending.authorization_pending")
    case "slow_down":
      return t("login.oauth.pending.slow_down")
    case "expired_token":
      return t("login.oauth.pending.expired_token")
    case "access_denied":
      return t("login.oauth.pending.access_denied")
    default:
      return errorCode
  }
}

function KvRow({
  label,
  value,
  mono,
  children,
}: {
  label: string
  value: string
  mono?: boolean
  children?: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[110px_1fr_auto] items-center gap-2 text-xs">
      <div className="text-muted-foreground">{label}</div>
      <div className={`${mono ? "font-mono break-all" : ""}`}>{value}</div>
      <div>{children}</div>
    </div>
  )
}
