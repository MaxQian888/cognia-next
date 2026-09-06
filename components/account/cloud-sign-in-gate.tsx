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
import { getPetWindowRole, isSecondaryOverlayRole } from "@/lib/pet/window-role"
import { detectHostProfile, type HostProfile } from "@/lib/platform/capabilities"
import { isCapacitor as detectCapacitor } from "@/lib/platform/detect"
import { openUrl } from "@/lib/native/opener"
import { createLogtoWebPopupDrivers } from "@/lib/logto/web-popup"
import { waitForLogtoDeepLinkCallback } from "@/lib/logto/deep-link-callback"
import { LogtoSignInCancelled, createLogtoCapacitorDrivers } from "@/lib/logto/capacitor-drivers"
import { signOutFromLogto } from "@/lib/logto/app-session"
import { CollabError, type CollabAccountMembership } from "@/lib/collab/client"
import { readCloudSessionState, type CloudSessionState } from "@/lib/identity/cloud-session"
import { completeSignOut } from "@/lib/identity/complete-sign-in"
import { UserBindingError } from "@/lib/identity/user-binding"
import {
  discoverDeployment,
  type DeploymentDiscovery,
  type ReadyDeployment,
} from "@/lib/identity/deployment-discovery"
import { subscribeDeploymentSource } from "@/lib/identity/deployment-source"
import {
  CloudSignInError,
  adoptOrganization,
  claimDeployment,
  redeemInvitation,
  settleAfterSignIn,
  signInWithDeployment,
  type CloudSignInMethod,
} from "@/lib/identity/cloud-sign-in-flow"
import { useAccountStore } from "@/stores/account/account-store"

import { NATIVE_CALLBACK_URI, type LogtoDrivers, type LogtoSession } from "@/lib/logto/client"
import type { SocialProvider } from "@/lib/identity/deployment-discovery"

import { CloudSignInScreen, type CloudSignInView } from "./cloud-sign-in-screen"

export const CLOUD_OFFLINE_KEY_PREFIX = "cognia.cloud-sign-in.offline"
const UNGATED_PATHS = ["/logto/callback", "/invite", "/pair", "/onboarding"]
export { NATIVE_CALLBACK_URI }
export const DESKTOP_CALLBACK_URI = NATIVE_CALLBACK_URI

export interface CloudSignInGateDeps {
  discover?: () => Promise<DeploymentDiscovery>
  readState?: (localAccountId: string) => Promise<CloudSessionState>
  signIn?: typeof signInWithDeployment
  settle?: typeof settleAfterSignIn
  adopt?: typeof adoptOrganization
  claim?: typeof claimDeployment
  redeem?: typeof redeemInvitation
  signOut?: (localAccountId: string) => Promise<void>
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
  const [view, setView] = useState<CloudSignInView>({ kind: "checking" })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [personName, setPersonName] = useState<string | null>(null)
  // Bumped when the profile chooses or forgets a deployment in Settings, so
  // the decision runs again against the new host without a reload.
  const [discoveryEpoch, setDiscoveryEpoch] = useState(0)
  const deploymentRef = useRef<ReadyDeployment | null>(null)
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

  const ungated =
    process.env.NEXT_PUBLIC_E2E === "1" ||
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
      setView({ kind: "settling" })
      setPhase("screen")
      try {
        const result = await (depsRef.current.settle ?? settleAfterSignIn)(deployment, session, {
          localAccountId: localAccountId ?? undefined,
        })
        if (result.outcome === "adopted") {
          setPhase("pass")
        } else if (result.outcome === "choose") {
          setView({ kind: "choose", memberships: result.memberships })
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
          setPhase("pass")
          return
        }
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
    (
      deployment: ReadyDeployment
    ): { drivers: LogtoDrivers; redirectUri: string; clientKind: "web" | "native" } => {
      // The Capacitor WebView cannot pop a window and has no https origin to
      // land on, so it is asked before the popup test that would otherwise
      // claim it: the in-app browser plus the native deep link is its path.
      if ((deps.isCapacitor ?? detectCapacitor)()) {
        return {
          drivers: createLogtoCapacitorDrivers(),
          redirectUri: NATIVE_CALLBACK_URI,
          clientKind: "native",
        }
      }
      const profile = deps.profile ?? detectHostProfile()
      const popupCapable =
        profile !== "desktop" && typeof window !== "undefined" && typeof window.open === "function"
      if (popupCapable) {
        return {
          drivers: createLogtoWebPopupDrivers(),
          redirectUri: `${window.location.origin}/logto/callback`,
          clientKind: "web",
        }
      }
      // The desktop has no popup: the system browser is sent to the deep link
      // registered on the native application. The OS hands that link back to
      // the running app, which resolves the wait on its own; pasting the
      // address stays available for a browser that never comes back.
      return {
        drivers: {
          openUrl: (url) => {
            void openUrl(url)
          },
          waitForCode: ({ state }) => {
            pendingState.current = state
            setView({ kind: "awaiting-code" })
            deepLinkWait.current?.abort()
            const controller = new AbortController()
            deepLinkWait.current = controller
            const pasted = new Promise<{ code: string; state: string }>((resolve, reject) => {
              codeResolver.current = resolve
              codeRejecter.current = reject
            })
            const delivered = waitForLogtoDeepLinkCallback({ state, signal: controller.signal })
            return Promise.race([pasted, delivered]).finally(() => controller.abort())
          },
        },
        redirectUri: NATIVE_CALLBACK_URI,
        clientKind: "native",
      }
    },
    [deps.profile, deps.isCapacitor]
  )

  const runSignIn = async (method: CloudSignInMethod) => {
    const deployment = deploymentRef.current
    if (!deployment || !localAccountId) return
    setError(null)
    setBusy(true)
    const { drivers, redirectUri, clientKind } = driversFor(deployment)
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
      codeResolver.current = null
      codeRejecter.current = null
      deepLinkWait.current?.abort()
      deepLinkWait.current = null
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

  if (!loaded || locked || !localAccountId || ungated) return <>{children}</>
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
        const deployment = deploymentRef.current
        if (deployment) setView({ kind: "sign-in", deployment, canContinueOffline: true })
      }}
      onContinueOffline={() => {
        rememberOffline(localAccountId)
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
