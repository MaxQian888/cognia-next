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
 *
 * Since ADR-0149 a successful sign-in also binds this LocalProfile to a
 * `User` — the token says who you are, and `completeSignIn` is what records it
 * in the registry, the projection and the host. The card shows the result so
 * "signed in to Logto" and "this profile belongs to Ada" are visibly the same
 * event rather than two states that can disagree.
 */

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react"
import { useTranslations } from "next-intl"
import { CloudIcon, LoaderIcon, LogInIcon, LogOutIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { SettingsBlock } from "@/components/settings/common/settings-block"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { isTauri } from "@/lib/tauri"
import { openUrl } from "@/lib/native/opener"
import { signInToLogto, signOutFromLogto, signOutLeftTokensLive } from "@/lib/logto/app-session"
import {
  cloudSessionNeedsReauth,
  isCloudSessionActive,
  readCloudSessionState,
  type CloudSessionState,
} from "@/lib/identity/cloud-session"
import { completeSignIn, completeSignOut } from "@/lib/identity/complete-sign-in"
import { UserBindingError } from "@/lib/identity/user-binding"
import type {
  LogtoClientConfig,
  LogtoDrivers,
  LogtoSession,
  LogtoSessionMetadata,
} from "@/lib/logto/client"

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

/** Pre-fill the form from what a lapsed session recorded, so "sign in again" is one click. */
function formFromMetadata(metadata: LogtoSessionMetadata | null, previous: FormState): FormState {
  if (!metadata) return previous
  return {
    ...previous,
    issuer: metadata.issuer,
    clientId: metadata.clientId,
    resource: metadata.resource,
    scope: metadata.scopes
      .filter((scope) => scope !== "openid" && scope !== "offline_access")
      .join(" "),
    org: metadata.organizationId ?? "",
  }
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
  const [cloud, setCloud] = useState<CloudSessionState | null>(null)
  const [loading, setLoading] = useState(true)
  const [step, setStep] = useState<Step>("idle")
  const [error, setError] = useState<string | null>(null)
  /** The person explicitly wants the form, even though a lapsed session could be shown instead. */
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [codeInput, setCodeInput] = useState("")
  const codeResolver = useRef<((v: { code: string; state: string }) => void) | null>(null)
  const codeRejecter = useRef<((e: Error) => void) | null>(null)
  const pendingState = useRef("")

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const state = await readCloudSessionState()
      setCloud(state)
      if (state.status === "reauth-required" || state.status === "error") {
        setForm((previous) => formFromMetadata(state.sessionMetadata, previous))
      }
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
    let next: LogtoSession | null = null
    try {
      next = await signInToLogto(config, drivers)
      setStep("idle")
      setCodeInput("")
      setShowForm(false)

      // The token proves who signed in; this is what makes the profile theirs.
      let mirroredToHost = true
      await completeSignIn(next, {
        onHostMirrorFailed: () => {
          mirroredToHost = false
        },
      })
      await reload()
      toast.success(t("toast.signedIn"))
      if (!mirroredToHost) toast.warning(t("toast.hostMirrorFailed"))
    } catch (e) {
      if (e instanceof UserBindingError && e.code === "already-bound-to-another-user") {
        // Named rather than generic: the useful fact is WHO holds this profile,
        // and that signing out here is the way forward. The Logto session is
        // real (it was persisted), so the state re-reads as binding-missing.
        setStep("idle")
        setError(
          t("errors.profileBoundToAnother", {
            name: e.existing?.displayName ?? e.existing?.userId ?? "",
          })
        )
        await reload()
        return
      }
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
    const report = await signOutFromLogto()
    // Drops the profile→person binding and tells the host to forget it. The
    // identity projection is left alone on purpose: those rows record who
    // people ARE, so clearing them would blank names on every existing row.
    await completeSignOut()
    setCloud({ status: "signed-out" })
    setShowForm(false)
    setError(null)
    toast.success(t("toast.signedOut"))
    // Local material is gone either way. What the person must not be left
    // believing is that the issuer forgot them too when it was never told.
    if (signOutLeftTokensLive(report)) toast.warning(t("toast.revocationFailed"))
    // RP-initiated logout: revocation kills the tokens, but the issuer's own
    // browser cookie would sign the same person straight back in on the next
    // authorize call without asking. Ending that session is part of signing out.
    if (report.endSessionUrl) void openUrl(report.endSessionUrl)
  }

  const session = cloud && isCloudSessionActive(cloud) ? cloud.session : null
  const identity = cloud && isCloudSessionActive(cloud) ? cloud.identity : null
  const lapsed =
    cloud &&
    (cloudSessionNeedsReauth(cloud) || cloud.status === "offline" || cloud.status === "error")
      ? cloud
      : null

  return (
    <SettingsBlock
      icon={<CloudIcon />}
      title={t("title")}
      description={t("description")}
      testid="logto-login-card"
      settingId="companion-logto"
      contentClassName="space-y-3"
    >
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
            <dt className="text-muted-foreground">{t("field.person")}</dt>
            <dd className="truncate text-xs" data-testid="logto-person">
              {identity ? (identity.displayName ?? identity.userId) : t("field.personNone")}
            </dd>
            <dt className="text-muted-foreground">{t("field.expires")}</dt>
            <dd className="text-xs">
              {session.expiresAt
                ? new Date(session.expiresAt).toLocaleString()
                : t("field.expiresUnknown")}
            </dd>
          </dl>
          {/* The Logto session and the profile binding can disagree: signing
                in genuinely succeeded while the profile turned out to belong to
                somebody else. Without this the refusal was invisible, because
                the error only rendered on the form branches. */}
          {error && (
            <p className="text-xs text-destructive" data-testid="logto-error">
              {error}
            </p>
          )}
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
      ) : lapsed && !showForm && step === "idle" ? (
        <div className="space-y-2" data-testid={`logto-state-${lapsed.status}`}>
          <p className="text-sm font-medium">
            {lapsed.status === "reauth-required"
              ? t("reauth.title")
              : lapsed.status === "offline"
                ? t("offline.title")
                : t("errorState.title")}
          </p>
          <p className="text-xs text-muted-foreground" data-testid="logto-state-reason">
            {lapsed.status === "reauth-required"
              ? t(
                  lapsed.reason === "expired"
                    ? "reauth.expired"
                    : lapsed.reason === "revoked"
                      ? "reauth.revoked"
                      : "reauth.bindingMissing"
                )
              : lapsed.status === "offline"
                ? t("offline.note")
                : t("errorState.note", { reason: lapsed.reason })}
          </p>
          {lapsed.sessionMetadata && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t("field.issuer")}</dt>
              <dd className="truncate font-mono text-xs">{lapsed.sessionMetadata.issuer}</dd>
              {lapsed.sessionMetadata.organizationId && (
                <>
                  <dt className="text-muted-foreground">{t("field.org")}</dt>
                  <dd className="truncate font-mono text-xs">
                    {lapsed.sessionMetadata.organizationId}
                  </dd>
                </>
              )}
            </dl>
          )}
          {error && (
            <p className="text-xs text-destructive" data-testid="logto-error">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {lapsed.status === "offline" ? (
              <Button size="sm" onClick={() => void reload()} data-testid="logto-retry">
                {t("offline.retry")}
              </Button>
            ) : (
              <Button size="sm" onClick={() => setShowForm(true)} data-testid="logto-sign-in-again">
                <LogInIcon className="size-4" aria-hidden />
                {t("reauth.signInAgain")}
              </Button>
            )}
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
            // i18n-exempt: OAuth scope identifiers, not translatable UI copy
            placeholder="brain:rpc brain:read"
          />
          <Field id="logto-org" label={t("field.org")} value={form.org} onChange={onField("org")} />
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
    </SettingsBlock>
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
