"use client"

/**
 * Settings → Cloud deployment: which Cognia Cloud this profile signs in to.
 *
 * # What replaced the Logto form
 *
 * The card before this one asked for an issuer, a client id, an API resource
 * and a redirect URI, ran PKCE by hand and stopped there: no memberships, no
 * organization, no invitation, so a person who "signed in" through it was
 * never in a workspace. The sign-in gate (`components/account/
 * cloud-sign-in-gate.tsx`) owns all of that now, and needs exactly one thing
 * from Settings: which gateway to ask. That is the whole job of this card.
 *
 * Check before use: `GET /api/auth/config` is fetched with the typed address
 * and the answer is shown (sign-in methods, collaboration service, join
 * policy) before anything is stored, so a wrong address is a message here
 * rather than an "unavailable" screen at the next boot.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { CloudIcon, LogInIcon, LogOutIcon, SearchCheckIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { SettingsBlock } from "@/components/settings/common/settings-block"
import { forgetOfflineChoice } from "@/components/account/cloud-sign-in-gate"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { readCloudSessionState, type CloudSessionState } from "@/lib/identity/cloud-session"
import { completeSignOut } from "@/lib/identity/complete-sign-in"
import {
  KNOWN_SOCIAL_PROVIDERS,
  discoverDeployment,
  type DeploymentDiscovery,
} from "@/lib/identity/deployment-discovery"
import {
  forgetDeploymentSource,
  loadDeploymentSource,
  normalizeDeploymentSource,
  saveDeploymentSource,
  subscribeDeploymentSource,
  type DeploymentSource,
  type DeploymentSourceDeps,
} from "@/lib/identity/deployment-source"
import { signOutFromLogto, signOutLeftTokensLive } from "@/lib/logto/app-session"
import { openUrl } from "@/lib/native/opener"

export interface CloudDeploymentCardDeps {
  /** Whose deployment. Defaults to the active local profile. */
  localAccountId?: string
  discover?: (source: DeploymentSource) => Promise<DeploymentDiscovery>
  readState?: (localAccountId: string) => Promise<CloudSessionState>
  signOut?: (
    localAccountId: string
  ) => Promise<{ endSessionUrl?: string | null; tokensLive: boolean }>
  /** What "sign in" does once the offline choice is withdrawn. */
  reload?: () => void
  storage?: DeploymentSourceDeps
}

export interface CloudDeploymentCardProps {
  /** `block` wraps the card in settings chrome. `plain` renders the body only. */
  frame?: "block" | "plain"
  /** Test seam. Production passes nothing. */
  deps?: CloudDeploymentCardDeps
}

async function defaultSignOut(localAccountId: string) {
  const report = await signOutFromLogto({ localAccountId })
  await completeSignOut({ localAccountId })
  return { endSessionUrl: report.endSessionUrl ?? null, tokensLive: signOutLeftTokensLive(report) }
}

function defaultReload(): void {
  window.location.reload()
}

export function CloudDeploymentCard({ frame = "block", deps = {} }: CloudDeploymentCardProps) {
  const t = useTranslations("account.cloud.deployment")
  const tCloud = useTranslations("account.cloud")
  const depsRef = useRef(deps)
  useEffect(() => {
    depsRef.current = deps
  })
  const [localAccountId] = useState(() => deps.localAccountId ?? getActiveAccountId())
  const [stored, setStored] = useState<DeploymentSource | null>(() =>
    loadDeploymentSource(localAccountId, deps.storage)
  )
  const [session, setSession] = useState<CloudSessionState | null>(null)
  const [editing, setEditing] = useState(false)
  const [url, setUrl] = useState("")
  const [fingerprint, setFingerprint] = useState("")
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState<{
    source: DeploymentSource
    result: DeploymentDiscovery
  } | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reloadSession = useCallback(async () => {
    const d = depsRef.current
    const next = await (
      d.readState ?? ((id: string) => readCloudSessionState({ localAccountId: id }))
    )(localAccountId)
    setSession(next)
  }, [localAccountId])

  useEffect(() => {
    if (!stored) return
    queueMicrotask(() => void reloadSession())
  }, [stored, reloadSession])

  useEffect(
    () =>
      subscribeDeploymentSource(() => {
        setStored(loadDeploymentSource(localAccountId, depsRef.current.storage))
      }),
    [localAccountId]
  )

  const check = async () => {
    setFormError(null)
    setChecked(null)
    const source = normalizeDeploymentSource({ baseUrl: url, fingerprint })
    if (!source) {
      setFormError(t("error.invalid"))
      return
    }
    setChecking(true)
    try {
      const result = await (
        depsRef.current.discover ??
        ((candidate: DeploymentSource) =>
          discoverDeployment({ localAccountId, deploymentSource: () => candidate }))
      )(source)
      setChecked({ source, result })
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setChecking(false)
    }
  }

  const use = () => {
    if (!checked || checked.result.status !== "ready") return
    try {
      saveDeploymentSource(localAccountId, checked.source, depsRef.current.storage)
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause))
      return
    }
    // A test storage seam publishes no change event. Read it back either way.
    setStored(loadDeploymentSource(localAccountId, depsRef.current.storage))
    forgetOfflineChoice(localAccountId)
    setEditing(false)
    setChecked(null)
    setUrl("")
    setFingerprint("")
  }

  const forget = () => {
    forgetDeploymentSource(localAccountId, depsRef.current.storage)
    setStored(loadDeploymentSource(localAccountId, depsRef.current.storage))
    setSession(null)
    setEditing(false)
  }

  const signIn = () => {
    forgetOfflineChoice(localAccountId)
    ;(depsRef.current.reload ?? defaultReload)()
  }

  const signOut = async () => {
    setBusy(true)
    try {
      const report = await (depsRef.current.signOut ?? defaultSignOut)(localAccountId)
      toast.success(t("signOutDone"))
      if (report.tokensLive) toast.warning(t("revocationFailed"))
      if (report.endSessionUrl) void openUrl(report.endSessionUrl)
      await reloadSession()
    } catch (cause) {
      toast.error(
        t("signOutFailed", { message: cause instanceof Error ? cause.message : String(cause) })
      )
    } finally {
      setBusy(false)
    }
  }

  const providerLabel = (provider: string) =>
    KNOWN_SOCIAL_PROVIDERS.has(provider) ? tCloud(`provider.${provider}`) : provider

  const form = (
    <div className="flex flex-col gap-3" data-testid="cloud-deployment-form">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="cloud-deployment-url">{t("field.url")}</Label>
        <Input
          id="cloud-deployment-url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={t("field.urlPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          data-testid="cloud-deployment-url"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="cloud-deployment-fingerprint">{t("field.fingerprint")}</Label>
        <Input
          id="cloud-deployment-fingerprint"
          value={fingerprint}
          onChange={(event) => setFingerprint(event.target.value)}
          placeholder={t("field.fingerprintPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-xs"
          data-testid="cloud-deployment-fingerprint"
        />
        <p className="text-xs text-muted-foreground">{t("field.fingerprintHint")}</p>
      </div>
      {formError ? (
        <p role="alert" className="text-xs text-destructive" data-testid="cloud-deployment-error">
          {formError}
        </p>
      ) : null}
      {checked ? <CheckResult checked={checked} providerLabel={providerLabel} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={checking || !url.trim()}
          onClick={() => void check()}
          data-testid="cloud-deployment-check"
        >
          {checking ? <Spinner className="size-4" /> : <SearchCheckIcon data-icon="inline-start" />}
          {checking ? t("checking") : t("check")}
        </Button>
        {checked?.result.status === "ready" ? (
          <Button type="button" size="sm" onClick={use} data-testid="cloud-deployment-use">
            <CloudIcon data-icon="inline-start" />
            {t("use")}
          </Button>
        ) : null}
        {stored ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditing(false)
              setChecked(null)
              setFormError(null)
            }}
            data-testid="cloud-deployment-cancel"
          >
            {t("cancel")}
          </Button>
        ) : null}
      </div>
    </div>
  )

  const current = stored ? (
    <div className="flex flex-col gap-3" data-testid="cloud-deployment-current">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t("current.url")}</dt>
        <dd className="truncate font-mono text-xs" data-testid="cloud-deployment-current-url">
          {stored.baseUrl}
        </dd>
        {stored.fingerprint ? (
          <>
            <dt className="text-muted-foreground">{t("current.fingerprint")}</dt>
            <dd className="truncate font-mono text-xs">{stored.fingerprint}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{t("current.session")}</dt>
        <dd className="text-xs" data-testid="cloud-deployment-session">
          {session === null ? (
            <span className="inline-flex items-center gap-2 text-muted-foreground">
              <Spinner className="size-3" />
              {t("session.loading")}
            </span>
          ) : session.status === "active" ? (
            <>
              <Badge variant="secondary">{t("session.active")}</Badge>{" "}
              {session.identity.displayName ?? session.identity.email ?? session.identity.userId}
            </>
          ) : (
            t(`session.${session.status}`)
          )}
        </dd>
      </dl>
      <div className="flex flex-wrap gap-2">
        {session?.status === "active" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void signOut()}
            data-testid="cloud-deployment-sign-out"
          >
            <LogOutIcon data-icon="inline-start" />
            {t("signOut")}
          </Button>
        ) : (
          <Button type="button" size="sm" onClick={signIn} data-testid="cloud-deployment-sign-in">
            <LogInIcon data-icon="inline-start" />
            {t("signIn")}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setUrl(stored.baseUrl)
            setFingerprint(stored.fingerprint ?? "")
            setEditing(true)
          }}
          data-testid="cloud-deployment-change"
        >
          {t("change")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={forget}
          data-testid="cloud-deployment-forget"
        >
          <Trash2Icon data-icon="inline-start" />
          {t("forget")}
        </Button>
      </div>
    </div>
  ) : null

  const body = (
    <div className="flex flex-col gap-3" data-testid="cloud-deployment-card" data-frame={frame}>
      {frame === "plain" ? (
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      ) : null}
      {stored && !editing ? current : form}
    </div>
  )

  if (frame === "plain") return body
  return (
    <SettingsBlock
      icon={<CloudIcon />}
      title={t("title")}
      description={t("description")}
      testid="cloud-deployment-block"
      settingId="companion-cloud-deployment"
    >
      {body}
    </SettingsBlock>
  )
}

function CheckResult({
  checked,
  providerLabel,
}: {
  checked: { source: DeploymentSource; result: DeploymentDiscovery }
  providerLabel: (provider: string) => string
}) {
  const t = useTranslations("account.cloud.deployment")
  const { result } = checked
  let content: ReactNode
  if (result.status === "ready") {
    content = (
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t("result.providers")}</dt>
        <dd data-testid="cloud-deployment-result-providers">
          {result.social.length > 0
            ? result.social.map((provider) => providerLabel(provider.provider)).join(", ")
            : t("result.providersNone")}
        </dd>
        <dt className="text-muted-foreground">{t("result.collaboration")}</dt>
        <dd className="truncate font-mono">
          {result.collaborationServiceUrl ?? t("result.collaborationMissing")}
        </dd>
        {result.registrationPolicy ? (
          <>
            <dt className="text-muted-foreground">{t("result.policy")}</dt>
            <dd className="font-mono">{result.registrationPolicy}</dd>
          </>
        ) : null}
      </dl>
    )
  } else if (result.status === "none") {
    content = <p className="text-xs text-muted-foreground">{t("result.singleUser")}</p>
  } else {
    content = (
      <p className="text-xs text-destructive">
        {t("result.unavailableMessage", { message: result.message })}
      </p>
    )
  }
  return (
    <div
      className="rounded-md border border-border/60 p-3"
      data-testid="cloud-deployment-result"
      data-status={result.status}
    >
      <p className="mb-2 text-xs font-medium">{t(`result.status.${result.status}`)}</p>
      {content}
    </div>
  )
}

export default CloudDeploymentCard
