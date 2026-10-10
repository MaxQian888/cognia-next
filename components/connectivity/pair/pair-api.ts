"use client"

import { getDeviceLabel } from "./pair-helpers"
import { decodePairPayload, type DecodeOutcome, type PairPayload } from "@/lib/qr/pair-payload"
import {
  authConfigIssuerKind,
  fetchCompanionAuthConfig,
  registerCompanionDevice,
  type PairOidcSession,
  type AuthFetcher,
} from "@/lib/tauri/companion-auth"
import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import { createRelayPairFetcher, type RelayPairFetcher } from "@/lib/tauri/relay-pair-fetch"
import { choosePairPath, type PairPath, type PairPathOptions } from "@/lib/companion/pair-path"
import { getActiveLogtoSession, signInToLogto } from "@/lib/logto/app-session"
import { createLogtoWebPopupDrivers } from "@/lib/logto/web-popup"
import { createLogtoCapacitorDrivers } from "@/lib/logto/capacitor-drivers"
import {
  nativeCallbackUriFor,
  ORGANIZATIONS_SCOPE,
  type LogtoDrivers,
  type OidcIssuerKind,
} from "@/lib/logto/client"
import { isCapacitor } from "@/lib/platform/detect"

// The direct-first path choice is shared with `cognia-agent host login`.
export { DIRECT_PAIR_PROBE_TIMEOUT_MS, type PairPath } from "@/lib/companion/pair-path"

/**
 * Registration outcome.
 *
 * The failure arms carry the *cause*, not only a rendered sentence: the caller
 * classifies it with `diagnosePairFailure` / `diagnosePayloadFailure`, which
 * need the `CompanionApiError` status, the decode outcome and the Host base URL
 * to tell "invitation already used" from "this browser cannot trust that
 * certificate". `message` stays for the log line and the technical-detail row.
 */
export type PairRegistrationResult =
  | { kind: "ok"; config: CompanionConfig; path: PairPath }
  | { kind: "invalid_payload"; message: string; outcome: DecodeFailure }
  | { kind: "registration_error"; message: string; error: unknown; baseUrl: string }

/** The non-`ok` arms of {@link DecodeOutcome}. */
export type DecodeFailure = Exclude<DecodeOutcome, { kind: "ok" }>

export async function registerPairPayload(
  rawPayload: string,
  fetcher?: AuthFetcher,
  options: RegisterPairOptions = {}
): Promise<PairRegistrationResult> {
  const decoded = decodePairPayload(rawPayload)
  if (decoded.kind !== "ok") {
    return {
      kind: "invalid_payload",
      outcome: decoded,
      message:
        decoded.kind === "version_mismatch"
          ? `unsupported pairing payload version ${decoded.got}`
          : decoded.kind === "invalid"
            ? decoded.message
            : "invalid pairing payload",
    }
  }
  return registerDecodedPairPayload(decoded.payload, fetcher, options)
}

export interface RegisterPairOptions extends PairPathOptions {
  /** Test injection of the relay fetcher factory. */
  createRelayFetcher?: typeof createRelayPairFetcher
}

export async function registerDecodedPairPayload(
  payload: PairPayload,
  fetcher?: AuthFetcher,
  options: RegisterPairOptions = {}
): Promise<PairRegistrationResult> {
  let relayRoom: RelayPairFetcher | null = null
  try {
    const path = await choosePairPath(payload, fetcher, options)
    let activeFetcher = fetcher
    if (path === "relay") {
      if (!payload.relay) throw new Error("this invitation carries no relay room")
      relayRoom = await (options.createRelayFetcher ?? createRelayPairFetcher)(payload.relay)
      activeFetcher = relayRoom.fetcher
    }
    const oidc = payload.mode === "oidc" ? await resolveOidcSession(payload, activeFetcher) : null
    const config = await registerCompanionDevice(
      {
        baseUrl: payload.baseUrl,
        mode: payload.mode,
        invitation: payload.invitation,
        hostId: payload.hostId,
        tenantId: payload.tenantId,
        displayName: getDeviceLabel(),
        serverVersion: payload.serverVersion,
        serverFingerprint: payload.fingerprint || undefined,
        ...(oidc ? { oidc } : {}),
      },
      activeFetcher
    )
    config.targetId = payload.hostId
    // A device that paired through the relay knows the relay works. Record
    // the rendezvous so the WAN tier dials the same one the Host sits in even
    // before the first (possibly unreachable) `/api/auth/config` refresh.
    if (path === "relay" && payload.relay && !config.signalingUrl) {
      config.signalingUrl = payload.relay.url
    }
    return { kind: "ok", config, path }
  } catch (error) {
    return {
      kind: "registration_error",
      error,
      baseUrl: payload.baseUrl,
      message: error instanceof Error ? error.message : String(error),
    }
  } finally {
    relayRoom?.close()
  }
}

async function resolveOidcSession(
  payload: PairPayload,
  fetcher?: AuthFetcher
): Promise<PairOidcSession> {
  const existing = await getActiveLogtoSession()
  if (existing) return existing
  if (typeof window === "undefined") throw new Error("an active OIDC session is required")
  const config = await fetchCompanionAuthConfig(
    payload.baseUrl,
    payload.fingerprint || undefined,
    fetcher
  )
  if (config.deploymentMode !== "multi-tenant" || !config.oidc) {
    throw new Error("server OIDC configuration is unavailable")
  }
  // The session this mints outlives the pairing: the cloud sign-in gate finds
  // it as the active session and adopts an organization by refreshing with
  // `organization_id`, which Logto only honours for a session that asked for
  // the organizations scope. Ask here, or that adoption fails later. Only
  // Logto has organizations; a generic issuer would refuse the scope.
  const issuerKind = authConfigIssuerKind(config)
  const scopes = Array.from(
    new Set([...config.oidc.scopes, ...(issuerKind === "logto" ? [ORGANIZATIONS_SCOPE] : [])])
  )
  const { drivers, redirectUri, clientId } = pairSignInDrivers(config.oidc, issuerKind)
  return signInToLogto(
    {
      issuer: config.oidc.issuer,
      clientId,
      redirectUri,
      resource: config.oidc.audience,
      scopes,
      organizationId: payload.tenantId,
      issuerKind,
    },
    drivers
  )
}

/**
 * The Capacitor shell has no popup and no https origin, so it signs in
 * through the in-app browser and the deep link registered on the native
 * Logto application. Every other shell that reaches `/pair` is a browser.
 */
function pairSignInDrivers(
  oidc: { webClientId: string; nativeClientId?: string },
  issuerKind: OidcIssuerKind
): {
  drivers: LogtoDrivers
  redirectUri: string
  clientId: string
} {
  if (isCapacitor()) {
    return {
      drivers: createLogtoCapacitorDrivers(),
      redirectUri: nativeCallbackUriFor(issuerKind),
      clientId: oidc.nativeClientId ?? oidc.webClientId,
    }
  }
  return {
    drivers: createLogtoWebPopupDrivers(),
    redirectUri: `${window.location.origin}/logto/callback`,
    clientId: oidc.webClientId,
  }
}
