"use client"

/**
 * Companion → Logto cloud sign-in card (ADR-0059 cloud/headless — Logto).
 *
 * The desktop consumer of the keyring-backed Logto session (`lib/logto/
 * app-session.ts` → `lib/logto/session-store.ts`). Follows the same
 * open-browser + paste-the-code-back flow as the Anthropic/Codex account
 * dialogs (no loopback server in the app shell): the user configures their
 * Logto app (issuer / client id / API resource / registered redirect URI),
 * signs in through the system browser, and pastes the callback URL (or bare
 * code) back. The resulting access token is persisted to the OS keyring and
 * used by the cloud/headless companion gateway.
 */

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react"
import { useTranslations } from "next-intl"
import { CloudIcon, LoaderIcon, LogInIcon, LogOutIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { isTauri } from "@/lib/tauri"
import { openUrl } from "@/lib/native/opener"
import { getActiveLogtoSession, signInToLogto, signOutFromLogto } from "@/lib/logto/app-session"
import type { LogtoClientConfig, LogtoDrivers, LogtoSession } from "@/lib/logto/client"

type Step = "idle" | "awaiting-code" | "exchanging"

interface FormState {
  issuer: string
  clientId: string
  resource: string
  redirectUri: string
  scope: string
  org: string
}

const EMPTY_FORM: FormState = {
  issuer: "",
  clientId: "",
  resource: "",
  redirectUri: "",
  scope: "",
  org: "",
}

/** Extract `code` (+ optional `state`) from a pasted callback URL or a bare code. */
export function extractCallback(input: string): { code: string; state?: string } | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    const code = url.searchParams.get("code")
    if (!code) return null
    const state = url.searchParams.get("state")
    return state ? { code, state } : { code }
  } catch {
    // Not a URL — accept a bare code (no whitespace).
    return /\s/.test(trimmed) ? null : { code: trimmed }
  }
}

export function LogtoLoginCard() {
  const t = useTranslations("mobile.companion.logto")
  const [session, setSession] = useState<LogtoSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [step, setStep] = useState<Step>("idle")
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [codeInput, setCodeInput] = useState("")
  const codeResolver = useRef<((v: { code: string; state: string }) => void) | null>(null)
  const codeRejecter = useRef<((e: Error) => void) | null>(null)
  const pendingState = useRef("")

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setSession(await getActiveLogtoSession())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Defer so the async reload (which flips `loading`) doesn't run as a
    // synchronous set-state in the effect body (react-hooks/set-state-in-effect).
    queueMicrotask(() => void reload())
  }, [reload])

  const onField =
    (key: keyof FormState) =>
    (e: ChangeEvent<HTMLInputElement>): void =>
      setForm((f) => ({ ...f, [key]: e.target.value }))

  const startSignIn = async (): Promise<void> => {
    setError(null)
    if (
      !form.issuer.trim() ||
      !form.clientId.trim() ||
      !form.resource.trim() ||
      !form.redirectUri.trim()
    ) {
      setError(t("errors.missingFields"))
      return
    }
    const config: LogtoClientConfig = {
      issuer: form.issuer.trim(),
      clientId: form.clientId.trim(),
      resource: form.resource.trim(),
      redirectUri: form.redirectUri.trim(),
      ...(form.scope.trim() ? { scopes: form.scope.split(/[,\s]+/).filter(Boolean) } : {}),
      ...(form.org.trim() ? { organizationId: form.org.trim() } : {}),
    }
    const drivers: LogtoDrivers = {
      openUrl: (url) => {
        void openUrl(url)
      },
      waitForCode: ({ state }) => {
        pendingState.current = state
        setStep("awaiting-code")
        return new Promise((resolve, reject) => {
          codeResolver.current = resolve
          codeRejecter.current = reject
        })
      },
    }
    try {
      const next = await signInToLogto(config, drivers)
      setSession(next)
      setStep("idle")
      setCodeInput("")
      toast.success(t("toast.signedIn"))
    } catch (e) {
      setStep("idle")
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      codeResolver.current = null
      codeRejecter.current = null
    }
  }

  const submitCode = (): void => {
    const extracted = extractCallback(codeInput)
    if (!extracted) {
      setError(t("errors.codeMalformed"))
      return
    }
    if (extracted.state && extracted.state !== pendingState.current) {
      setError(t("errors.stateMismatch"))
      return
    }
    setError(null)
    setStep("exchanging")
    codeResolver.current?.({ code: extracted.code, state: pendingState.current })
  }

  const cancelSignIn = (): void => {
    codeRejecter.current?.(new Error("cancelled"))
    setStep("idle")
    setCodeInput("")
    setError(null)
  }

  const signOut = async (): Promise<void> => {
    await signOutFromLogto()
    setSession(null)
    toast.success(t("toast.signedOut"))
  }

  return (
    <Card data-testid="logto-login-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CloudIcon className="size-4" aria-hidden />
          {t("title")}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Not a desktop-only gate any more: `openUrl` already routes through
            the Tauri opener, the Capacitor in-app browser or `window.open`, and
            the session store falls back to an encrypted IndexedDB vault. What
            differs is where the token ends up, which is worth saying out loud
            rather than implying the feature is missing. */}
        {!isTauri() && (
          <p className="text-xs text-muted-foreground" data-testid="logto-storage-note">
            {t("storageFallback")}
          </p>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderIcon className="size-4 animate-spin" aria-hidden />
            {t("loading")}
          </div>
        ) : session ? (
          <div className="space-y-2" data-testid="logto-signed-in">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t("field.issuer")}</dt>
              <dd className="truncate font-mono text-xs">{session.issuer}</dd>
              <dt className="text-muted-foreground">{t("field.resource")}</dt>
              <dd className="truncate font-mono text-xs">{session.resource}</dd>
              {session.organizationId && (
                <>
                  <dt className="text-muted-foreground">{t("field.org")}</dt>
                  <dd className="truncate font-mono text-xs">{session.organizationId}</dd>
                </>
              )}
              <dt className="text-muted-foreground">{t("field.expires")}</dt>
              <dd className="text-xs">
                {session.expiresAt
                  ? new Date(session.expiresAt).toLocaleString()
                  : t("field.expiresUnknown")}
              </dd>
            </dl>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void signOut()}
              data-testid="logto-sign-out"
            >
              <LogOutIcon className="size-4" aria-hidden />
              {t("signOut")}
            </Button>
          </div>
        ) : step === "idle" ? (
          <div className="space-y-2" data-testid="logto-sign-in-form">
            <Field
              id="logto-issuer"
              label={t("field.issuer")}
              value={form.issuer}
              onChange={onField("issuer")}
              placeholder="https://logto.example.com/oidc"
            />
            <Field
              id="logto-client-id"
              label={t("field.clientId")}
              value={form.clientId}
              onChange={onField("clientId")}
            />
            <Field
              id="logto-resource"
              label={t("field.resource")}
              value={form.resource}
              onChange={onField("resource")}
              placeholder="https://api.example.com"
            />
            <Field
              id="logto-redirect"
              label={t("field.redirectUri")}
              value={form.redirectUri}
              onChange={onField("redirectUri")}
            />
            <Field
              id="logto-scope"
              label={t("field.scope")}
              value={form.scope}
              onChange={onField("scope")}
              placeholder="brain:rpc brain:read"
            />
            <Field
              id="logto-org"
              label={t("field.org")}
              value={form.org}
              onChange={onField("org")}
            />
            {error && (
              <p className="text-xs text-destructive" data-testid="logto-error">
                {error}
              </p>
            )}
            <Button size="sm" onClick={() => void startSignIn()} data-testid="logto-sign-in">
              <LogInIcon className="size-4" aria-hidden />
              {t("signIn")}
            </Button>
          </div>
        ) : (
          <div className="space-y-2" data-testid="logto-awaiting-code">
            <p className="text-sm text-muted-foreground">{t("awaitingCode")}</p>
            <div className="flex flex-col gap-1">
              <Label htmlFor="logto-code">{t("field.code")}</Label>
              <Input
                id="logto-code"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
                placeholder={t("field.codePlaceholder")}
                data-testid="logto-code-input"
                disabled={step === "exchanging"}
              />
            </div>
            {error && (
              <p className="text-xs text-destructive" data-testid="logto-error">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={submitCode}
                disabled={step === "exchanging"}
                data-testid="logto-submit-code"
              >
                {step === "exchanging" ? (
                  <LoaderIcon className="size-4 animate-spin" aria-hidden />
                ) : null}
                {t("submitCode")}
              </Button>
              <Button variant="ghost" size="sm" onClick={cancelSignIn} data-testid="logto-cancel">
                {t("cancel")}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string
  label: string
  value: string
  onChange: (e: ChangeEvent<HTMLInputElement>) => void
  placeholder?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={onChange} placeholder={placeholder} data-testid={id} />
    </div>
  )
}
