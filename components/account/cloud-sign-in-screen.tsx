"use client"

/**
 * The sign-in screen the cloud gate shows. Presentation only: every decision
 * is the gate's, every server call is the flow's, and this file renders the
 * view it is handed and reports what the person pressed.
 */

import { useId, useState, type FormEvent, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { CloudIcon, LogInIcon, LogOutIcon, WifiOffIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { Surface } from "@/components/surface/surface"
import { isInvitationTokenShaped } from "@/lib/identity/pending-invitation"

import type { CollabAccountMembership } from "@/lib/collab/client"
import type { ReadyDeployment, SocialProvider } from "@/lib/identity/deployment-discovery"
import type { CloudSessionReauthReason } from "@/lib/identity/cloud-session"
import type { LogtoClientConfig } from "@/lib/logto/client"

export type CloudSignInView =
  | { kind: "checking" }
  | {
      kind: "sign-in"
      deployment: ReadyDeployment
      /** Why a previous session is not enough, when there was one. */
      reauth?: CloudSessionReauthReason | "offline"
      canContinueOffline: boolean
    }
  | { kind: "awaiting-code" }
  | { kind: "signing-in" }
  | { kind: "settling" }
  | { kind: "choose"; memberships: CollabAccountMembership[] }
  | { kind: "unaffiliated"; deployment: ReadyDeployment; allowClaim: boolean }
  | { kind: "unavailable"; baseUrl: string; message: string; canContinueOffline: boolean }

export interface CloudSignInScreenProps {
  view: CloudSignInView
  error: string | null
  busy: boolean
  /** Shown once a session exists, so the person knows who they are joining as. */
  personName?: string | null
  onSocial: (provider: SocialProvider) => void
  onLogto: () => void
  onManual: (config: LogtoClientConfig) => void
  onSubmitCode: (pasted: string) => void
  onCancelCode: () => void
  onContinueOffline: () => void
  onChoose: (membership: CollabAccountMembership) => void
  onRedeem: (token: string) => void
  onClaim: (input: { credential: string; orgName: string }) => void
  onSignOut: () => void
}

const KNOWN_PROVIDERS = new Set(["github", "feishu", "lark", "google", "microsoft", "wechat"])

export function CloudSignInScreen(props: CloudSignInScreenProps) {
  const t = useTranslations("account.cloud")
  const { view, error, busy } = props

  return (
    <main
      className="flex min-h-dvh items-center justify-center bg-background px-4 text-foreground"
      data-testid="cloud-sign-in"
      data-view={view.kind}
    >
      <section className="flex w-full max-w-md flex-col gap-4">
        {view.kind === "checking" || view.kind === "signing-in" || view.kind === "settling" ? (
          <Pending
            label={t(
              view.kind === "checking"
                ? "checking"
                : view.kind === "signing-in"
                  ? "signingIn"
                  : "settling"
            )}
          />
        ) : null}

        {view.kind === "sign-in" ? <SignInBody {...props} view={view} /> : null}

        {view.kind === "awaiting-code" ? (
          <CodeForm busy={busy} onSubmit={props.onSubmitCode} onCancel={props.onCancelCode} />
        ) : null}

        {view.kind === "choose" ? (
          <ChooseBody memberships={view.memberships} busy={busy} onChoose={props.onChoose} />
        ) : null}

        {view.kind === "unaffiliated" ? (
          <UnaffiliatedBody
            allowClaim={view.allowClaim}
            busy={busy}
            onRedeem={props.onRedeem}
            onClaim={props.onClaim}
          />
        ) : null}

        {view.kind === "unavailable" ? (
          <div className="flex flex-col gap-3" data-testid="cloud-sign-in-unavailable">
            <Heading icon={<WifiOffIcon className="size-5" aria-hidden />}>
              {t("unavailable.title")}
            </Heading>
            <p className="text-sm text-muted-foreground">
              {t("unavailable.body", { baseUrl: view.baseUrl, message: view.message })}
            </p>
            {view.canContinueOffline ? <OfflineButton onClick={props.onContinueOffline} /> : null}
          </div>
        ) : null}

        {error ? (
          <Surface asChild layer="raised" radius="control">
            <p
              role="alert"
              className="border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive"
              data-testid="cloud-sign-in-error"
            >
              {error}
            </p>
          </Surface>
        ) : null}

        {props.personName && (view.kind === "choose" || view.kind === "unaffiliated") ? (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span data-testid="cloud-sign-in-person">
              {t("signedInAs", { name: props.personName })}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={props.onSignOut}
              data-testid="cloud-sign-in-sign-out"
            >
              <LogOutIcon data-icon="inline-start" />
              {t("signOut")}
            </Button>
          </div>
        ) : null}
      </section>
    </main>
  )
}

function Heading({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {icon}
      </div>
      <h1 className="text-lg font-semibold">{children}</h1>
    </div>
  )
}

function Pending({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <Spinner className="size-4" />
      {label}
    </div>
  )
}

function OfflineButton({ onClick }: { onClick: () => void }) {
  const t = useTranslations("account.cloud")
  return (
    <div className="flex flex-col gap-1">
      <Button type="button" variant="outline" onClick={onClick} data-testid="cloud-sign-in-offline">
        <WifiOffIcon data-icon="inline-start" />
        {t("continueOffline")}
      </Button>
      <p className="text-xs text-muted-foreground">{t("continueOfflineHint")}</p>
    </div>
  )
}

function SignInBody({
  view,
  busy,
  onSocial,
  onLogto,
  onManual,
  onContinueOffline,
}: CloudSignInScreenProps & { view: Extract<CloudSignInView, { kind: "sign-in" }> }) {
  const t = useTranslations("account.cloud")
  const [advanced, setAdvanced] = useState(false)
  const deploymentName = view.deployment.config.oidc?.issuer
    ? safeHost(view.deployment.config.oidc.issuer)
    : null

  return (
    <div className="flex flex-col gap-4" data-testid="cloud-sign-in-methods">
      <Heading icon={<CloudIcon className="size-5" aria-hidden />}>
        {deploymentName ? t("title", { deployment: deploymentName }) : t("titleGeneric")}
      </Heading>
      {view.reauth ? (
        <p className="text-sm" data-testid={`cloud-sign-in-reauth-${view.reauth}`}>
          {view.reauth === "offline" ? t("offline.body") : t(`reauth.${view.reauth}`)}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      )}

      <div className="flex flex-col gap-2">
        {view.deployment.social.map((provider) => (
          <Button
            key={provider.provider}
            type="button"
            disabled={busy}
            onClick={() => onSocial(provider)}
            data-testid={`cloud-sign-in-social-${provider.provider}`}
          >
            <LogInIcon data-icon="inline-start" />
            {t("continueWith", {
              provider: KNOWN_PROVIDERS.has(provider.provider)
                ? t(`provider.${provider.provider}`)
                : provider.provider,
            })}
          </Button>
        ))}
        <Button
          type="button"
          variant={view.deployment.social.length ? "outline" : "default"}
          disabled={busy}
          onClick={onLogto}
          data-testid="cloud-sign-in-logto"
        >
          <LogInIcon data-icon="inline-start" />
          {t("continueWithLogto")}
        </Button>
      </div>

      {view.canContinueOffline ? <OfflineButton onClick={onContinueOffline} /> : null}

      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          aria-expanded={advanced}
          onClick={() => setAdvanced((value) => !value)}
          data-testid="cloud-sign-in-advanced-toggle"
        >
          {t("advanced.toggle")}
        </Button>
        {advanced ? <ManualForm busy={busy} onSubmit={onManual} /> : null}
      </div>
    </div>
  )
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function ManualForm({
  busy,
  onSubmit,
}: {
  busy: boolean
  onSubmit: (config: LogtoClientConfig) => void
}) {
  const t = useTranslations("account.cloud.advanced")
  const id = useId()
  const [form, setForm] = useState({ issuer: "", clientId: "", resource: "", redirectUri: "" })
  const [missing, setMissing] = useState(false)
  const field =
    (key: keyof typeof form) =>
    (event: FormEvent<HTMLInputElement>): void => {
      // Read before the updater runs: the event is not live inside it.
      const next = event.currentTarget.value
      setForm((value) => ({ ...value, [key]: next }))
    }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = {
      issuer: form.issuer.trim(),
      clientId: form.clientId.trim(),
      resource: form.resource.trim(),
      redirectUri: form.redirectUri.trim(),
    }
    if (!trimmed.issuer || !trimmed.clientId || !trimmed.resource || !trimmed.redirectUri) {
      setMissing(true)
      return
    }
    setMissing(false)
    onSubmit(trimmed)
  }
  return (
    <form className="flex flex-col gap-2" onSubmit={submit} data-testid="cloud-sign-in-manual">
      {(["issuer", "clientId", "resource", "redirectUri"] as const).map((key) => (
        <div key={key} className="flex flex-col gap-1">
          <Label htmlFor={`${id}-${key}`}>{t(key)}</Label>
          <Input
            id={`${id}-${key}`}
            value={form[key]}
            onInput={field(key)}
            data-testid={`cloud-sign-in-manual-${key}`}
          />
        </div>
      ))}
      {missing ? (
        <p role="alert" className="text-xs text-destructive">
          {t("missing")}
        </p>
      ) : null}
      <Button
        type="submit"
        variant="outline"
        disabled={busy}
        data-testid="cloud-sign-in-manual-submit"
      >
        {t("submit")}
      </Button>
    </form>
  )
}

function CodeForm({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean
  onSubmit: (pasted: string) => void
  onCancel: () => void
}) {
  const t = useTranslations("account.cloud")
  const [value, setValue] = useState("")
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(value)
      }}
      data-testid="cloud-sign-in-code"
    >
      <Heading icon={<LogInIcon className="size-5" aria-hidden />}>{t("signingIn")}</Heading>
      <p className="text-sm text-muted-foreground">{t("awaitingCode")}</p>
      <Input
        value={value}
        placeholder={t("codePlaceholder")}
        onChange={(event) => setValue(event.target.value)}
        data-testid="cloud-sign-in-code-input"
      />
      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={busy || !value.trim()}
          data-testid="cloud-sign-in-code-submit"
        >
          {t("submitCode")}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  )
}

function ChooseBody({
  memberships,
  busy,
  onChoose,
}: {
  memberships: CollabAccountMembership[]
  busy: boolean
  onChoose: (membership: CollabAccountMembership) => void
}) {
  const t = useTranslations("account.cloud.choose")
  return (
    <div className="flex flex-col gap-3" data-testid="cloud-sign-in-choose">
      <Heading icon={<CloudIcon className="size-5" aria-hidden />}>{t("title")}</Heading>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      <ul className="flex flex-col gap-2">
        {memberships.map((membership) => (
          <li
            key={membership.orgId}
            className="flex items-center gap-3 rounded-md border p-3"
            data-testid={`cloud-sign-in-org-${membership.orgId}`}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{membership.orgName}</p>
              <p className="text-xs text-muted-foreground">
                {t(`role.${membership.orgRole ?? "guest"}`)}
                {" · "}
                {t("workspaces", { count: membership.workspaceCount })}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => onChoose(membership)}
              data-testid={`cloud-sign-in-choose-${membership.orgId}`}
            >
              {t("select")}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function UnaffiliatedBody({
  allowClaim,
  busy,
  onRedeem,
  onClaim,
}: {
  allowClaim: boolean
  busy: boolean
  onRedeem: (token: string) => void
  onClaim: (input: { credential: string; orgName: string }) => void
}) {
  const t = useTranslations("account.cloud")
  const id = useId()
  const [token, setToken] = useState("")
  const [tokenInvalid, setTokenInvalid] = useState(false)
  const [credential, setCredential] = useState("")
  const [orgName, setOrgName] = useState("")
  const [claimMissing, setClaimMissing] = useState(false)

  return (
    <div className="flex flex-col gap-5" data-testid="cloud-sign-in-unaffiliated">
      <div className="flex flex-col gap-1">
        <Heading icon={<CloudIcon className="size-5" aria-hidden />}>
          {t("unaffiliated.title")}
        </Heading>
        <p className="text-sm text-muted-foreground">{t("unaffiliated.description")}</p>
      </div>

      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (!isInvitationTokenShaped(token)) {
            setTokenInvalid(true)
            return
          }
          setTokenInvalid(false)
          onRedeem(token.trim())
        }}
        data-testid="cloud-sign-in-redeem"
      >
        <h2 className="text-sm font-medium">{t("invitation.title")}</h2>
        <Label htmlFor={`${id}-token`}>{t("invitation.tokenLabel")}</Label>
        <Input
          id={`${id}-token`}
          value={token}
          placeholder={t("invitation.tokenPlaceholder")}
          onChange={(event) => setToken(event.target.value)}
          data-testid="cloud-sign-in-token"
        />
        {tokenInvalid ? (
          <p role="alert" className="text-xs text-destructive">
            {t("invitation.invalid")}
          </p>
        ) : null}
        <Button type="submit" disabled={busy} data-testid="cloud-sign-in-redeem-submit">
          {t("invitation.submit")}
        </Button>
      </form>

      {allowClaim ? (
        <form
          className="flex flex-col gap-2 border-t pt-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (!credential.trim() || !orgName.trim()) {
              setClaimMissing(true)
              return
            }
            setClaimMissing(false)
            onClaim({ credential: credential.trim(), orgName: orgName.trim() })
          }}
          data-testid="cloud-sign-in-claim"
        >
          <h2 className="text-sm font-medium">{t("claim.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("claim.description")}</p>
          <Label htmlFor={`${id}-credential`}>{t("claim.credentialLabel")}</Label>
          <Input
            id={`${id}-credential`}
            type="password"
            autoComplete="off"
            value={credential}
            placeholder={t("claim.credentialPlaceholder")}
            onChange={(event) => setCredential(event.target.value)}
            data-testid="cloud-sign-in-credential"
          />
          <Label htmlFor={`${id}-org`}>{t("claim.orgNameLabel")}</Label>
          <Input
            id={`${id}-org`}
            value={orgName}
            placeholder={t("claim.orgNamePlaceholder")}
            onChange={(event) => setOrgName(event.target.value)}
            data-testid="cloud-sign-in-org-name"
          />
          {claimMissing ? (
            <p role="alert" className="text-xs text-destructive">
              {t("claim.missing")}
            </p>
          ) : null}
          <Button
            type="submit"
            variant="outline"
            disabled={busy}
            data-testid="cloud-sign-in-claim-submit"
          >
            {t("claim.submit")}
          </Button>
        </form>
      ) : null}
    </div>
  )
}

export default CloudSignInScreen
