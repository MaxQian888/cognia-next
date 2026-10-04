"use client"

/**
 * The cloud identity gate: after the local profile is unlocked, before the
 * shells paint. ADR-0149 sections 8 and 9.
 *
 * # What it decides
 *
 * Discovery (`lib/identity/deployment-discovery.ts`) says whether there is a
 * multi-tenant deployment to sign in to at all. Most installs have none, and
 * the gate renders its children at once. When there is one, the profile's
 * cloud session decides: active and bound to an organization passes, signed
 * out or lapsed shows the sign-in screen, active without an organization
 * looks the person's memberships up and either adopts the one org, offers
 * the several, or asks for an invitation or the bootstrap credential.
 *
 * # The official account
 *
 * With no self-hosted deployment, discovery offers the official Cognia
 * account instead (`status: "official"`, ADR-0215 §2). It is personal: an
 * active session passes with no organization, and signing in binds the
 * profile and links the person's sign-ins (`personal-sign-in.ts`). Its screen
 * is offered ONCE per profile (`official-sign-in-prompt.ts`): signing in or
 * continuing offline is remembered for good, and after that Settings →
 * Account asks for the screen through `sign-in-request.ts`. Answering that
 * request swaps the app for the screen until it is done, the same as a
 * deployment chosen in Settings re-runs the decision.
 *
 * # Offline is a choice, not a failure
 *
 * The local profile works without the cloud. "Continue offline" is always on
 * the screen and remembered for the tab, so a person on a train is not held
 * at a sign-in they cannot complete. The choice is per profile and per tab:
 * a new tab asks again, which is the cheapest honest reminder.
 *
 * # Paths that must never be gated
 *
 * The Logto callback page lives inside this layout and would otherwise be
 * gated by the very sign-in it completes. The invitation landing page, the
 * pairing flow and onboarding likewise run before a person could pass.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { usePathname } from "next/navigation"
import { useTranslations } from "next-intl"

import { extractCallback } from "@/lib/logto/extract-callback"
import { isDevLocalAccountEnabled } from "@/lib/accounts/dev-auto-unlock"
import { getPetWindowRole, isSecondaryOverlayRole } from "@/lib/pet/window-role"
import { detectHostProfile, type HostProfile } from "@/lib/platform/capabilities"
import { platformSignInDrivers } from "@/lib/logto/platform-drivers"
import { LogtoSignInCancelled } from "@/lib/logto/capacitor-drivers"
import { signOutFromLogto } from "@/lib/logto/app-session"
import { CollabError, type CollabAccountMembership } from "@/lib/collab/client"
import { readCloudSessionState, type CloudSessionState } from "@/lib/identity/cloud-session"
import { readLogtoIdentity } from "@/lib/identity/logto-claims"
import { completeSignOut } from "@/lib/identity/complete-sign-in"
import { UserBindingError } from "@/lib/identity/user-binding"
import { configureHostDeployment } from "@/lib/identity/host-person"
import { authConfigIssuerKind } from "@/lib/tauri/companion-auth"
import {
  discoverDeployment,
  type DeploymentDiscovery,
  type ReadyDeployment,
} from "@/lib/identity/deployment-discovery"
import { subscribeDeploymentSource } from "@/lib/identity/deployment-source"
import {
  recordOfficialPromptDecision,
  shouldOfferOfficialSignIn,
} from "@/lib/identity/official-sign-in-prompt"
import { signInToOfficialAccount } from "@/lib/identity/personal-sign-in"
import { isOfficialIssuer } from "@/lib/identity/official-deployment"
import { subscribeCloudSignInRequest } from "@/lib/identity/sign-in-request"
import {
  CloudSignInError,
  adoptOrganization,
  claimDeployment,
  redeemInvitation,
  settleAfterSignIn,
  signInWithDeployment,
  type CloudSignInMethod,
} from "@/lib/identity/cloud-sign-in-flow"
import { isShareViewerRoute } from "@/lib/share/viewer-context"
import { useAccountStore } from "@/stores/account/account-store"

import { type LogtoSession, type OidcIssuerKind } from "@/lib/logto/client"
import type { SocialProvider } from "@/lib/identity/deployment-discovery"
import type { OfficialDeployment, OfficialSocialProvider } from "@/lib/identity/official-deployment"

import { CloudSignInScreen, type CloudSignInView } from "./cloud-sign-in-screen"

export const CLOUD_OFFLINE_KEY_PREFIX = "cognia.cloud-sign-in.offline"
const UNGATED_PATHS = ["/logto/callback", "/invite", "/pair", "/onboarding"]

export interface CloudSignInGateDeps {
  discover?: () => Promise<DeploymentDiscovery>
  readState?: (localAccountId: string) => Promise<CloudSessionState>
  signIn?: typeof signInWithDeployment
  /** Sign in to the official account. Defaults to the personal flow. */
  signInOfficial?: typeof signInToOfficialAccount
  settle?: typeof settleAfterSignIn
  adopt?: typeof adoptOrganization
  claim?: typeof claimDeployment
  redeem?: typeof redeemInvitation
  signOut?: (localAccountId: string) => Promise<void>
  /** Point the desktop host at the deployment. Defaults to the Tauri command. */
  configureHost?: typeof configureHostDeployment
  profile?: HostProfile
  /** Whether this is the Capacitor shell. Defaults to the runtime detector. */
  isCapacitor?: () => boolean
  pathname?: string | null
}

export interface CloudSignInGateProps {
  children: ReactNode
  /** Test seam. Production passes nothing. */
  deps?: CloudSignInGateDeps
}

function offlineKey(localAccountId: string): string {
  return `${CLOUD_OFFLINE_KEY_PREFIX}.${localAccountId}`
}

export function hasChosenOffline(localAccountId: string): boolean {
  try {
    return sessionStorage.getItem(offlineKey(localAccountId)) === "1"
  } catch {
    return false
  }
}

function rememberOffline(localAccountId: string): void {
  try {
    sessionStorage.setItem(offlineKey(localAccountId), "1")
  } catch {
    // A tab that cannot remember asks again next time. Acceptable.
  }
}

/**
 * Withdraw the tab's "continue offline" choice, so the next decision asks
 * again. Settings call this before pointing the gate at a deployment.
 */
export function forgetOfflineChoice(localAccountId: string): void {
  try {
    sessionStorage.removeItem(offlineKey(localAccountId))
  } catch {
    // Nothing to forget.
  }
}

async function defaultSignOut(localAccountId: string): Promise<void> {
  await signOutFromLogto({ localAccountId })
  await completeSignOut({ localAccountId })
}

export function CloudSignInGate({ children, deps = {} }: CloudSignInGateProps) {
  const t = useTranslations("account.cloud")
  const routerPathname = usePathname()
  const pathname = deps.pathname ?? routerPathname
  const loaded = useAccountStore((state) => state.loaded)
  const locked = useAccountStore((state) => state.locked)
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  const activeAccountId = useAccountStore((state) => state.activeAccountId)
  const localAccountId = unlockedAccountId ?? activeAccountId

  const [phase, setPhase] = useState<"checking" | "pass" | "screen">("checking")
  // Settings asked for the screen: shown even where the gate is skipped.
  const [requested, setRequested] = useState(false)
  const [view, setView] = useState<CloudSignInView>({ kind: "checking" })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [personName, setPersonName] = useState<string | null>(null)
  // Bumped when the profile chooses or forgets a deployment in Settings, so
  // the decision runs again against the new host without a reload.
  const [discoveryEpoch, setDiscoveryEpoch] = useState(0)
  const deploymentRef = useRef<ReadyDeployment | null>(null)
  const officialRef = useRef<OfficialDeployment | null>(null)
  const sessionRef = useRef<LogtoSession | null>(null)
  // The decision effect reads its collaborators through refs: the deps
  // object, the translator and the settle step all take new identities on
  // renders, and an effect that followed them would re-run discovery on
  // every render, overriding the very state a sign-in just produced.
  const depsRef = useRef(deps)
  const tRef = useRef(t)
  useEffect(() => {
    depsRef.current = deps
    tRef.current = t
  })
  const codeResolver = useRef<((value: { code: string; state: string }) => void) | null>(null)
  const codeRejecter = useRef<((error: Error) => void) | null>(null)
  const pendingState = useRef("")
  const deepLinkWait = useRef<AbortController | null>(null)

  // The E2E build walks past the gate, except in the lane that exists to test
  // it: `NEXT_PUBLIC_E2E_CLOUD_GATE=1` keeps the gate live under E2E.
  const ungated =
    isDevLocalAccountEnabled() ||
    (process.env.NEXT_PUBLIC_E2E === "1" && process.env.NEXT_PUBLIC_E2E_CLOUD_GATE !== "1") ||
    // This entry handles Feishu SSO itself, then requests the existing host
    // pairing or team sign-in according to the mode the user opens.
    /^\/lark\/workbench(?:\/|\.html)?$/.test(pathname ?? "") ||
    // A share link is readable without any account (ADR-0037, "The anonymous
    // visitor"), and a web sign-in round-trips through the identity provider,
    // which comes back without the link's `#k=` key.
    isShareViewerRoute(pathname) ||
    (pathname ? UNGATED_PATHS.some((prefix) => pathname.startsWith(prefix)) : false) ||
    isSecondaryOverlayRole(getPetWindowRole())

  const explain = useCallback(
    (cause: unknown): string => {
      if (cause instanceof UserBindingError && cause.code === "already-bound-to-another-user") {
        return t("error.profileBoundToAnother", {
          name: cause.existing?.displayName ?? cause.existing?.userId ?? "",
        })
      }
      if (cause instanceof LogtoSignInCancelled) return ""
      if (cause instanceof CloudSignInError) {
        if (cause.code === "cancelled") return ""
        if (cause.code === "reauth-required") return t("error.reauthRequired")
        if (cause.code === "no-collaboration-service") return t("error.noCollaborationService")
      }
      if (cause instanceof CollabError && (cause.status === 403 || cause.status === 404)) {
        return t("error.notInvited")
      }
      return t("error.generic", { message: cause instanceof Error ? cause.message : String(cause) })
    },
    [t]
  )

  const settle = useCallback(
    async (session: LogtoSession) => {
      const deployment = deploymentRef.current
      if (!deployment) return
      sessionRef.current = session
      // Name the person on the screens that follow. Before this only a
      // session found at boot had a name, and a fresh sign-in asked "redeem an
      // invitation" without saying who was asking.
      const identity = readLogtoIdentity(session)
      if (identity) {
        setPersonName(identity.profile.name ?? identity.profile.email ?? null)
      }
      setView({ kind: "settling" })
      setPhase("screen")
      try {
        const result = await (depsRef.current.settle ?? settleAfterSignIn)(deployment, session, {
          localAccountId: localAccountId ?? undefined,
        })
        if (result.outcome === "adopted") {
          setPhase("pass")
        } else if (result.outcome === "choose") {
          setView({
            kind: "choose",
            memberships: result.memberships,
            identities: result.identities,
          })
        } else {
          setView({
            kind: "unaffiliated",
            deployment,
            allowClaim:
              deployment.registrationPolicy === null ||
              deployment.registrationPolicy === "bootstrap-then-invite",
          })
        }
      } catch (cause) {
        setError(explain(cause))
        setView({ kind: "sign-in", deployment, canContinueOffline: true })
      }
    },
    [explain, localAccountId]
  )
  const settleRef = useRef(settle)
  useEffect(() => {
    settleRef.current = settle
  })

  useEffect(() => subscribeDeploymentSource(() => setDiscoveryEpoch((epoch) => epoch + 1)), [])

  // Settings → Account asks for the screen; the gate shows it for the
  // deployment it already discovered, without a reload.
  // A gate that never decided (skipped in development, or still checking)
  // discovers on demand, so the request is never silently dropped.
  useEffect(
    () =>
      subscribeCloudSignInRequest((request) => {
        if (!localAccountId || request.localAccountId !== localAccountId) return
        void (async () => {
          if (!officialRef.current && !deploymentRef.current) {
            const discovery = await (
              depsRef.current.discover ?? (() => discoverDeployment({ localAccountId }))
            )()
            if (discovery.status === "official") officialRef.current = discovery.deployment
            else if (discovery.status === "ready") deploymentRef.current = discovery
          }
          const official = officialRef.current
          const deployment = deploymentRef.current
          if (!official && !deployment) return
          setError(null)
          setView(
            official
              ? { kind: "official", deployment: official }
              : { kind: "sign-in", deployment: deployment!, canContinueOffline: true }
          )
          setRequested(true)
          setPhase("screen")
        })()
      }),
    [localAccountId]
  )

  // The decision, once per profile, path and chosen deployment. Deferred out
  // of the effect body so no state is set synchronously inside it.
  useEffect(() => {
    if (!loaded || locked || !localAccountId) return
    if (ungated) {
      queueMicrotask(() => setPhase("pass"))
      return
    }
    let cancelled = false
    queueMicrotask(() => {
      void (async () => {
        if (discoveryEpoch > 0) {
          // A deployment chosen after boot: the gate is probably passed, and
          // must not stay passed against a host it has never asked.
          setPhase("checking")
          setView({ kind: "checking" })
          setError(null)
        }
        const discovery = await (
          depsRef.current.discover ?? (() => discoverDeployment({ localAccountId }))
        )()
        if (cancelled) return
        if (discovery.status === "none") {
          deploymentRef.current = null
          officialRef.current = null
          setPhase("pass")
          return
        }
        if (discovery.status === "official") {
          deploymentRef.current = null
          officialRef.current = discovery.deployment
          const state = await (
            depsRef.current.readState ??
            ((id: string) => readCloudSessionState({ localAccountId: id }))
          )(localAccountId)
          if (cancelled) return
          // An official session (or one kept while the issuer is unreachable)
          // is enough: the official account has no organization to settle. A
          // session some other issuer minted (a deployment since forgotten) is
          // not this account. Without one, the screen is offered until the
          // profile answers it, once.
          const issuer =
            state.status === "active"
              ? state.session.issuer
              : state.status === "offline" || state.status === "reauth-required"
                ? (state.sessionMetadata?.issuer ?? null)
                : null
          const ours = issuer !== null && isOfficialIssuer(issuer, discovery.deployment)
          if (
            (ours && (state.status === "active" || state.status === "offline")) ||
            !shouldOfferOfficialSignIn(localAccountId)
          ) {
            setPhase("pass")
            return
          }
          setView({
            kind: "official",
            deployment: discovery.deployment,
            ...(ours && state.status === "reauth-required" ? { reauth: state.reason } : {}),
          })
          setPhase("screen")
          return
        }
        officialRef.current = null
        if (discovery.status === "unavailable") {
          if (hasChosenOffline(localAccountId)) {
            setPhase("pass")
            return
          }
          setView({
            kind: "unavailable",
            baseUrl: discovery.baseUrl,
            message: discovery.message,
            canContinueOffline: true,
          })
          setPhase("screen")
          return
        }
        deploymentRef.current = discovery
        if ((depsRef.current.profile ?? detectHostProfile()) === "desktop") {
          // The host verifies every sign-in against a trust anchor of its own.
          // A desktop has no environment to read one from, so it is pointed at
          // the same gateway the renderer just discovered, and fetches the
          // issuer from there itself. Best-effort: a host that refuses (locked,
          // or a companion server that never ran) leaves sign-in usable and
          // only the device attribution undone.
          void (depsRef.current.configureHost ?? configureHostDeployment)({
            gatewayUrl: discovery.baseUrl,
            ...(discovery.fingerprint ? { fingerprint: discovery.fingerprint } : {}),
            replace: true,
          }).catch((cause: unknown) => {
            console.warn("[identity] the host could not be pointed at the deployment", cause)
          })
        }
        const state = await (
          depsRef.current.readState ??
          ((id: string) => readCloudSessionState({ localAccountId: id }))
        )(localAccountId)
        if (cancelled) return
        if (state.status === "active") {
          setPersonName(state.identity.displayName ?? state.identity.email ?? null)
          if (state.identity.orgId) {
            setPhase("pass")
            return
          }
          await settleRef.current(state.session)
          return
        }
        if (state.status === "offline") {
          // A kept session on an unreachable issuer: the plane refreshes on
          // its own once the issuer answers. Nothing to ask the person.
          setPhase("pass")
          return
        }
        if (hasChosenOffline(localAccountId)) {
          setPhase("pass")
          return
        }
        const reauth =
          state.status === "reauth-required"
            ? state.reason
            : state.status === "error"
              ? ("expired" as const)
              : undefined
        if (state.status === "error") {
          setError(tRef.current("error.generic", { message: state.reason }))
        }
        setView({
          kind: "sign-in",
          deployment: discovery,
          ...(reauth ? { reauth } : {}),
          canContinueOffline: true,
        })
        setPhase("screen")
      })()
    })
    return () => {
      cancelled = true
    }
  }, [loaded, locked, localAccountId, ungated, discoveryEpoch])

  const driversFor = useCallback(
    (issuerKind: OidcIssuerKind) => {
      deepLinkWait.current?.abort()
      const controller = new AbortController()
      deepLinkWait.current = controller
      return platformSignInDrivers({
        issuerKind,
        ...(deps.profile ? { profile: deps.profile } : {}),
        ...(deps.isCapacitor ? { isCapacitor: deps.isCapacitor } : {}),
        signal: controller.signal,
        // The desktop also accepts a pasted callback address, for a browser
        // that never hands the deep link back.
        pasted: (state) => {
          pendingState.current = state
          // The sign-in is waiting on the person now: the paste box must take
          // input, which a still-busy screen would refuse.
          setBusy(false)
          setView({ kind: "awaiting-code" })
          return new Promise<{ code: string; state: string }>((resolve, reject) => {
            codeResolver.current = resolve
            codeRejecter.current = reject
          })
        },
      })
    },
    [deps.profile, deps.isCapacitor]
  )

  const endCodeWait = () => {
    codeResolver.current = null
    codeRejecter.current = null
    deepLinkWait.current?.abort()
    deepLinkWait.current = null
  }

  const runSignIn = async (method: CloudSignInMethod) => {
    const deployment = deploymentRef.current
    if (!deployment || !localAccountId) return
    setError(null)
    setBusy(true)
    const { drivers, redirectUri, clientKind } = driversFor(authConfigIssuerKind(deployment.config))
    setView({ kind: "signing-in" })
    try {
      const session = await (deps.signIn ?? signInWithDeployment)(
        deployment,
        method,
        drivers,
        { redirectUri, clientKind },
        { localAccountId }
      )
      setBusy(false)
      await settle(session)
    } catch (cause) {
      setBusy(false)
      // A cancel is the person's own choice, not a failure to report.
      const message = explain(cause)
      setError(message || null)
      setView({ kind: "sign-in", deployment, canContinueOffline: true })
    } finally {
      endCodeWait()
    }
  }

  const runOfficialSignIn = async (provider: OfficialSocialProvider) => {
    const deployment = officialRef.current
    if (!deployment || !localAccountId) return
    setError(null)
    setBusy(true)
    const { drivers, redirectUri, clientKind } = driversFor(deployment.issuerKind)
    setView({ kind: "signing-in" })
    try {
      await (deps.signInOfficial ?? signInToOfficialAccount)(
        deployment,
        drivers,
        { redirectUri, clientKind, socialProvider: provider },
        { localAccountId }
      )
      recordOfficialPromptDecision(localAccountId, "signed-in")
      setBusy(false)
      setPhase("pass")
    } catch (cause) {
      setBusy(false)
      const message = explain(cause)
      setError(message || null)
      setView({ kind: "official", deployment })
    } finally {
      endCodeWait()
    }
  }

  const act = async (work: () => Promise<void>) => {
    setError(null)
    setBusy(true)
    try {
      await work()
    } catch (cause) {
      setError(explain(cause))
    } finally {
      setBusy(false)
    }
  }

  const withSession = (
    work: (deployment: ReadyDeployment, session: LogtoSession) => Promise<unknown>
  ) =>
    act(async () => {
      const deployment = deploymentRef.current
      const session = sessionRef.current
      if (!deployment || !session) throw new CloudSignInError("reauth-required", "no session")
      await work(deployment, session)
      setPhase("pass")
    })

  if (!loaded || locked || !localAccountId) return <>{children}</>
  if (ungated && !requested) return <>{children}</>
  if (phase === "pass") return <>{children}</>

  return (
    <CloudSignInScreen
      view={view}
      error={error}
      busy={busy}
      personName={personName}
      onSocial={(provider: SocialProvider) =>
        void runSignIn({ kind: "social", directSignIn: provider.directSignIn })
      }
      onOfficialProvider={(provider) => void runOfficialSignIn(provider)}
      onLogto={() => void runSignIn({ kind: "logto" })}
      onManual={(config) => void runSignIn({ kind: "manual", config })}
      onSubmitCode={(pasted) => {
        const extracted = extractCallback(pasted)
        if (!extracted) {
          setError(t("error.callbackMalformed"))
          return
        }
        if (extracted.state && extracted.state !== pendingState.current) {
          setError(t("error.stateMismatch"))
          return
        }
        setError(null)
        setView({ kind: "signing-in" })
        codeResolver.current?.({ code: extracted.code, state: pendingState.current })
      }}
      onCancelCode={() => {
        codeRejecter.current?.(new CloudSignInError("cancelled", "cancelled"))
        const official = officialRef.current
        const deployment = deploymentRef.current
        if (official) setView({ kind: "official", deployment: official })
        else if (deployment) setView({ kind: "sign-in", deployment, canContinueOffline: true })
      }}
      onContinueOffline={() => {
        if (view.kind === "official") recordOfficialPromptDecision(localAccountId, "offline")
        else rememberOffline(localAccountId)
        setPhase("pass")
      }}
      onChoose={(membership: CollabAccountMembership) =>
        void withSession((deployment, session) =>
          (deps.adopt ?? adoptOrganization)(
            deployment,
            session,
            {
              orgId: membership.orgId,
              logtoOrganizationId: membership.logtoOrganizationId ?? "",
              userId: membership.userId,
              ...(view.kind === "choose" && view.identities && view.identities.length > 0
                ? { identities: view.identities }
                : {}),
            },
            { localAccountId }
          )
        )
      }
      onRedeem={(token) =>
        void withSession((deployment, session) =>
          (deps.redeem ?? redeemInvitation)(deployment, session, token, { localAccountId })
        )
      }
      onClaim={(input) =>
        void withSession((deployment, session) =>
          (deps.claim ?? claimDeployment)(deployment, session, input, { localAccountId })
        )
      }
      onSignOut={() =>
        void act(async () => {
          await (deps.signOut ?? defaultSignOut)(localAccountId)
          sessionRef.current = null
          setPersonName(null)
          const deployment = deploymentRef.current
          if (deployment) setView({ kind: "sign-in", deployment, canContinueOffline: true })
        })
      }
    />
  )
}

export default CloudSignInGate
