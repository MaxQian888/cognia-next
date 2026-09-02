"use client"

/**
 * The Identity tab of the account manager: who this profile is on the shared
 * deployment, which organization it works in, and the organizations it could
 * switch to. ADR-0149 section 9.
 *
 * Reads the same cloud session state the settings card reads, and switches
 * organizations through the same `adoptOrganization` the sign-in gate uses,
 * so there is one way to change standing and it is tested once.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { CloudIcon, LoaderIcon, LogInIcon, LogOutIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CollabClient, type CollabAccountMembership } from "@/lib/collab/client"
import { adoptOrganization } from "@/lib/identity/cloud-sign-in-flow"
import { readCloudSessionState, type CloudSessionState } from "@/lib/identity/cloud-session"
import { completeSignOut } from "@/lib/identity/complete-sign-in"
import { discoverDeployment, type DeploymentDiscovery } from "@/lib/identity/deployment-discovery"
import { signOutFromLogto, signOutLeftTokensLive } from "@/lib/logto/app-session"
import { openUrl } from "@/lib/native/opener"
import { createPlatformFetch } from "@/lib/network/platform-fetch"
import { CLOUD_OFFLINE_KEY_PREFIX } from "@/components/account/cloud-sign-in-gate"

import type { LocalAccountRecord } from "@/lib/accounts/account-types"

export interface AccountIdentityTabDeps {
  readState?: (localAccountId: string) => Promise<CloudSessionState>
  discover?: () => Promise<DeploymentDiscovery>
  listMemberships?: (
    serviceUrl: string,
    accessToken: string
  ) => Promise<{ memberships: CollabAccountMembership[] }>
  adopt?: typeof adoptOrganization
  signOut?: (
    localAccountId: string
  ) => Promise<{ endSessionUrl?: string | null; tokensLive: boolean }>
  reload?: () => void
}

export interface AccountIdentityTabProps {
  account: LocalAccountRecord
  deps?: AccountIdentityTabDeps
}

async function defaultListMemberships(serviceUrl: string, accessToken: string) {
  const client = new CollabClient({
    baseUrl: serviceUrl,
    accessToken: async () => accessToken,
    fetchImpl: createPlatformFetch(),
  })
  return client.accountMemberships()
}

async function defaultSignOut(localAccountId: string) {
  const report = await signOutFromLogto({ localAccountId })
  await completeSignOut({ localAccountId })
  return { endSessionUrl: report.endSessionUrl ?? null, tokensLive: signOutLeftTokensLive(report) }
}

export function AccountIdentityTab({ account, deps = {} }: AccountIdentityTabProps) {
  const t = useTranslations("account.identity")
  const [state, setState] = useState<CloudSessionState | null>(null)
  const [discovery, setDiscovery] = useState<DeploymentDiscovery | null>(null)
  const [memberships, setMemberships] = useState<CollabAccountMembership[] | null>(null)
  const [membershipsError, setMembershipsError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const depsRef = useRef(deps)
  useEffect(() => {
    depsRef.current = deps
  })

  const load = useCallback(async () => {
    const d = depsRef.current
    const [next, found] = await Promise.all([
      (d.readState ?? ((id: string) => readCloudSessionState({ localAccountId: id })))(account.id),
      (d.discover ?? discoverDeployment)(),
    ])
    setState(next)
    setDiscovery(found)
    if (next.status === "active" && found.status === "ready" && found.collaborationServiceUrl) {
      try {
        const answer = await (d.listMemberships ?? defaultListMemberships)(
          found.collaborationServiceUrl,
          next.session.accessToken
        )
        setMemberships(answer.memberships)
        setMembershipsError(null)
      } catch (cause) {
        setMemberships(null)
        setMembershipsError(cause instanceof Error ? cause.message : String(cause))
      }
    } else {
      setMemberships(null)
    }
  }, [account.id])

  useEffect(() => {
    queueMicrotask(() => void load())
  }, [load])

  const switchTo = async (membership: CollabAccountMembership) => {
    if (state?.status !== "active" || discovery?.status !== "ready") return
    setBusy(true)
    try {
      await (depsRef.current.adopt ?? adoptOrganization)(
        discovery,
        state.session,
        {
          orgId: membership.orgId,
          logtoOrganizationId: membership.logtoOrganizationId ?? "",
          userId: membership.userId,
        },
        { localAccountId: account.id }
      )
      toast.success(t("switched", { org: membership.orgName }))
      await load()
    } catch (cause) {
      toast.error(
        t("switchFailed", { message: cause instanceof Error ? cause.message : String(cause) })
      )
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    setBusy(true)
    try {
      const report = await (depsRef.current.signOut ?? defaultSignOut)(account.id)
      toast.success(t("signOutDone"))
      if (report.tokensLive) toast.warning(t("revocationFailed"))
      if (report.endSessionUrl) void openUrl(report.endSessionUrl)
      await load()
    } finally {
      setBusy(false)
    }
  }

  const signIn = () => {
    // The gate decides at boot. Forget the tab's offline choice and let it.
    try {
      sessionStorage.removeItem(`${CLOUD_OFFLINE_KEY_PREFIX}.${account.id}`)
    } catch {
      // Nothing to forget.
    }
    ;(depsRef.current.reload ?? (() => window.location.reload()))()
  }

  if (!state || !discovery) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <LoaderIcon className="size-4 animate-spin" aria-hidden />
        {t("loading")}
      </div>
    )
  }

  const currentOrgId = state.status === "active" ? state.identity.orgId : undefined

  return (
    <div
      className="flex flex-col gap-4"
      data-testid="account-identity-tab"
      data-status={state.status}
    >
      <div>
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <CloudIcon className="size-4" aria-hidden />
          {t("title")}
        </h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      {state.status === "active" ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t("person")}</dt>
          <dd className="truncate" data-testid="account-identity-person">
            {state.identity.displayName ?? state.identity.email ?? state.identity.userId}
          </dd>
          <dt className="text-muted-foreground">{t("organization")}</dt>
          <dd className="truncate font-mono text-xs" data-testid="account-identity-org">
            {memberships?.find((row) => row.orgId === currentOrgId)?.orgName ??
              currentOrgId ??
              t("membershipsEmpty")}
          </dd>
          {state.identity.orgRole ? (
            <>
              <dt className="text-muted-foreground">{t("role")}</dt>
              <dd className="text-xs">{t(`roleName.${state.identity.orgRole}`)}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">{t("session")}</dt>
          <dd className="text-xs">
            <Badge variant="secondary">{t("state.active")}</Badge>{" "}
            {state.session.expiresAt
              ? t("sessionExpires", { date: new Date(state.session.expiresAt).toLocaleString() })
              : t("sessionUnknownExpiry")}
          </dd>
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="account-identity-signed-out">
          {state.status === "signed-out" ? t("signedOut") : t(`state.${state.status}`)}
        </p>
      )}

      {state.status === "active" ? (
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-medium text-muted-foreground">{t("memberships")}</h4>
          {membershipsError ? (
            <p role="alert" className="text-xs text-destructive">
              {t("membershipsFailed", { message: membershipsError })}
            </p>
          ) : memberships === null ? (
            discovery.status === "ready" && discovery.collaborationServiceUrl ? (
              <p className="text-xs text-muted-foreground">{t("membershipsLoading")}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{t("noDeployment")}</p>
            )
          ) : memberships.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("membershipsEmpty")}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {memberships.map((membership) => {
                const current = membership.orgId === currentOrgId
                return (
                  <li
                    key={membership.orgId}
                    className="flex items-center gap-2 text-sm"
                    data-testid={`account-identity-membership-${membership.orgId}`}
                  >
                    <span className="min-w-0 flex-1 truncate">{membership.orgName}</span>
                    {current ? (
                      <Badge variant="secondary">{t("current")}</Badge>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void switchTo(membership)}
                        data-testid={`account-identity-switch-${membership.orgId}`}
                      >
                        {busy ? t("switching") : t("switch")}
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      ) : null}

      <div className="flex gap-2">
        {state.status === "active" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void signOut()}
            data-testid="account-identity-sign-out"
          >
            <LogOutIcon data-icon="inline-start" />
            {t("signOut")}
          </Button>
        ) : discovery.status === "ready" ? (
          <Button type="button" size="sm" onClick={signIn} data-testid="account-identity-sign-in">
            <LogInIcon data-icon="inline-start" />
            {t("signIn")}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">{t("noDeployment")}</p>
        )}
      </div>
    </div>
  )
}

export default AccountIdentityTab
