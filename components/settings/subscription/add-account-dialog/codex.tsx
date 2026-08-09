"use client"

// Codex add-account dialog — two modes:
//
//   • Reuse — when `~/.codex/auth.json` (or codex-cli's keyring entry)
//     already holds a valid credential, one click copies it into the
//     unified vault as a new account. We never write back to codex-cli's
//     source files.
//
//   • OAuth — device-code flow against `auth.openai.com`. Renders the
//     `user_code` + `verification_uri` so the user can complete sign-in
//     in their browser.

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
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

import {
  discoveredToCredential,
  toCodexProviderCredential,
} from "@/lib/subscription/codex/discovery"
import {
  deadlineMsFromResponse,
  intervalMsFromResponse,
  pendingIsTerminal,
  pollCodexDeviceCode,
  pollOutcomeKind,
  pollOutcomePayload,
  requestCodexDeviceCode,
  tokenResponseToCredential,
} from "@/lib/subscription/codex/oauth"
import type {
  DeviceCodePendingPayload,
  DeviceCodeResponse,
  TokenResponse,
} from "@/lib/subscription/core/transport"
import { persistProviderAccount } from "@/lib/subscription/core/account-lifecycle"
import { uuidv7 } from "@/lib/subscription/core/uuidv7"
import { useCodexDiscovery } from "@/lib/subscription/codex/hooks"
import type { DiscoveredCodexAuth } from "@/lib/subscription/codex/discovery"
import type { Account, CodexCredentialData } from "@/types/subscription"
import { openUrl } from "@/lib/native/opener"

export type CodexLoginMode = "reuse" | "oauth"

export interface CodexAddAccountDialogProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  onAdded?: (account: Account) => void
  /** Default mode shown when the dialog opens. */
  initialMode?: CodexLoginMode
  existingAccount?: Account
}

type OAuthStep = "request" | "awaiting" | "exchanging" | "done"

export function CodexAddAccountDialog({
  open,
  onOpenChange,
  onAdded,
  initialMode,
  existingAccount,
}: CodexAddAccountDialogProps) {
  const t = useTranslations("subscription.codex")
  const tAccountList = useTranslations("subscription.common.accountList")

  const { discovered, loading: discoveryLoading, reload: reloadDiscovery } = useCodexDiscovery()

  const computedDefault: CodexLoginMode = useMemo(() => {
    if (initialMode) return initialMode
    return discovered ? "reuse" : "oauth"
  }, [initialMode, discovered])

  const [mode, setMode] = useState<CodexLoginMode>(computedDefault)
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

  const persistAccount = async (data: CodexCredentialData) => {
    const now = Date.now()
    const tagged = toCodexProviderCredential(data)
    const account: Account = {
      ...(existingAccount ?? {}),
      id: existingAccount?.id ?? uuidv7(now),
      credential: tagged,
      createdAtMs: existingAccount?.createdAtMs ?? now,
      lastUsedAtMs: now,
    }
    await persistProviderAccount("codex", account)
    toast.success(tAccountList(existingAccount ? "credentialsUpdated" : "accountAdded"))
    onAdded?.(account)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("login.title")}</DialogTitle>
          <DialogDescription>{t("login.modeGroupLabel")}</DialogDescription>
        </DialogHeader>

        <RadioGroup
          value={mode}
          onValueChange={(v) => setMode(v as CodexLoginMode)}
          className="grid gap-2"
        >
          <ModeRow
            id="codex-mode-reuse"
            value="reuse"
            icon={<ShieldCheckIcon className="size-4" />}
            title={t("login.modes.reuse.label")}
            description={t("login.modes.reuse.description")}
            disabled={!discovered}
          />
          <ModeRow
            id="codex-mode-oauth"
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
              await persistAccount(next)
            }}
          />
        ) : (
          <OAuthPanel
            onCompleted={async (response) => {
              const next = tokenResponseToCredential(response, { authMode: "chatgpt" })
              await persistAccount(next)
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
  onAdopt: (credential: CodexCredentialData) => Promise<void>
}) {
  const t = useTranslations("subscription.codex.login.reuse")
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
        {t("scanning")}
      </p>
    )
  }

  if (!discovered) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{t("noneFound")}</p>
        <Button variant="outline" size="sm" onClick={() => void onReload()}>
          <RefreshCwIcon className="mr-2 size-4" />
          {t("rescan")}
        </Button>
      </div>
    )
  }

  const canAdopt = !!credentialPreview
  const sourceLabel = discovered.source === "file" ? t("sourceFile") : t("sourceKeyring")

  return (
    <div className="space-y-3 text-sm">
      <div className="rounded border bg-muted/30 px-3 py-2 space-y-1">
        <KvRow label={t("sourceLabel")} value={sourceLabel} />
        <KvRow label={t("authJsonPath")} value={discovered.authJsonPath} mono />
        {discovered.authMode && <KvRow label={t("authMode")} value={discovered.authMode} />}
        {discovered.tokens?.email && <KvRow label={t("email")} value={discovered.tokens.email} />}
        {discovered.tokens?.chatgptPlanType && (
          <KvRow label={t("plan")} value={discovered.tokens.chatgptPlanType} />
        )}
        {discovered.lastRefreshIso && (
          <KvRow label={t("lastRefresh")} value={discovered.lastRefreshIso} />
        )}
      </div>

      {!canAdopt && <p className="text-xs text-destructive">{t("notAdoptable")}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" size="sm" onClick={() => void onReload()}>
          <RefreshCwIcon className="mr-2 size-4" />
          {t("rescan")}
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
              setError(t("adoptFailed", { error: e instanceof Error ? e.message : String(e) }))
            } finally {
              setAdopting(false)
            }
          }}
        >
          {adopting && <Loader2Icon className="mr-2 size-4 animate-spin" />}
          {t("adopt")}
        </Button>
      </div>
    </div>
  )
}

function OAuthPanel({ onCompleted }: { onCompleted: (response: TokenResponse) => Promise<void> }) {
  const t = useTranslations("subscription.codex.login.oauth")
  const tActions = useTranslations("subscription.codex.login.actions")
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
    setStep("awaiting")
    try {
      const res = await requestCodexDeviceCode()
      setDevice(res)
      const url = res.verification_uri_complete ?? res.verification_uri
      if (url) void openUrl(url)
      void pollLoop(res)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStep("request")
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
        const outcome = await pollCodexDeviceCode(res.device_code, res.user_code)
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
        <p className="text-muted-foreground">{t("starting")}</p>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button size="sm" onClick={() => void onStart()}>
          {tActions("startOauth")}
        </Button>
      </div>
    )
  }

  if (step === "awaiting" && device) {
    const url = device.verification_uri_complete ?? device.verification_uri
    let pendingLabel: string | null = null
    if (pending) {
      if (pending.error === "expired_token") pendingLabel = t("expired")
      else if (pending.error === "access_denied") pendingLabel = t("accessDenied")
      else pendingLabel = t("polling")
    }
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{t("pasteHint")}</p>
        <div className="rounded border bg-muted/30 px-3 py-2 space-y-2">
          <KvRow label={t("userCodeLabel")} value={device.user_code} mono>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (typeof navigator !== "undefined" && navigator.clipboard) {
                  void navigator.clipboard.writeText(device.user_code)
                }
              }}
              className="h-6 px-2"
            >
              <CopyIcon className="size-3" />
            </Button>
          </KvRow>
          <KvRow label={t("verificationUriLabel")} value={url ?? ""} mono>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => url && void openUrl(url)}
              className="h-6 px-2"
            >
              <ExternalLinkIcon className="size-3" />
            </Button>
          </KvRow>
        </div>
        {pendingLabel && (
          <Badge variant="outline" className="text-[10px]">
            {pendingLabel}
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
        {t("polling")}
      </p>
    )
  }

  return <p className="text-sm text-muted-foreground">{t("granted")}</p>
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
      <div className={mono ? "font-mono break-all" : ""}>{value}</div>
      <div>{children}</div>
    </div>
  )
}
