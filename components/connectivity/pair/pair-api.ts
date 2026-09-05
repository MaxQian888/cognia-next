"use client"

import { getDeviceLabel } from "./pair-helpers"
import { decodePairPayload, type DecodeOutcome, type PairPayload } from "@/lib/qr/pair-payload"
import {
  fetchCompanionAuthConfig,
  registerCompanionDevice,
  type PairOidcSession,
  type AuthFetcher,
} from "@/lib/tauri/companion-auth"
import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import { createRelayPairFetcher, type RelayPairFetcher } from "@/lib/tauri/relay-pair-fetch"
import { getActiveLogtoSession, signInToLogto } from "@/lib/logto/app-session"
import { createLogtoWebPopupDrivers } from "@/lib/logto/web-popup"

/**
 * How long a direct probe of the Host may take before the relay is used
 * instead (ADR-0170). A reachable Host answers `/api/auth/config` in well
 * under a second on a LAN and in a second or two through a tunnel. A Host
 * that is not reachable on `baseUrl` would otherwise make the user wait out
 * the platform's own connect timeout, with an invitation ticking away.
 */
export const DIRECT_PAIR_PROBE_TIMEOUT_MS = 4_000

/** How the registration reached the Host. */
export type PairPath = "direct" | "relay"

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

export interface RegisterPairOptions {
  /**
   * Force a path. `undefined` (the default) probes the Host directly first
   * and falls back to the relay when the invitation carries one.
   */
  path?: PairPath
  /** Test injection of the relay fetcher factory. */
  createRelayFetcher?: typeof createRelayPairFetcher
  /** Test injection of the direct probe. */
  probeDirect?: (payload: PairPayload, fetcher: AuthFetcher | undefined) => Promise<boolean>
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

/**
 * Direct first, relay second (ADR-0170). Direct is preferred because it is the
 * path every later request takes on a LAN or tunnel, and because a Host that
 * answers directly proves `baseUrl` for the credential record. The relay is
 * taken when there is one and the Host does not answer within the probe
 * window, or when the transport pre-check already refuses the direct address
 * (a plaintext off-machine URL a browser must not use).
 */
async function choosePairPath(
  payload: PairPayload,
  fetcher: AuthFetcher | undefined,
  options: RegisterPairOptions
): Promise<PairPath> {
  if (options.path) return options.path
  if (!payload.relay) return "direct"
  const probe = options.probeDirect ?? probeDirectDefault
  return (await probe(payload, fetcher)) ? "direct" : "relay"
}

async function probeDirectDefault(
  payload: PairPayload,
  fetcher: AuthFetcher | undefined
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DIRECT_PAIR_PROBE_TIMEOUT_MS)
  try {
    const config = await fetchCompanionAuthConfig(
      payload.baseUrl,
      payload.fingerprint || undefined,
      fetcher,
      { signal: controller.signal }
    )
    return config.hostId === payload.hostId
  } catch {
    return false
  } finally {
    clearTimeout(timer)
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
  return signInToLogto(
    {
      issuer: config.oidc.issuer,
      clientId: config.oidc.webClientId,
      redirectUri: `${window.location.origin}/logto/callback`,
      resource: config.oidc.audience,
      scopes: config.oidc.scopes,
      organizationId: payload.tenantId,
    },
    createLogtoWebPopupDrivers()
  )
}
