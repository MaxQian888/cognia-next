"use client"

import { getDeviceLabel } from "./pair-helpers"
import { decodePairPayload, type PairPayload } from "@/lib/qr/pair-payload"
import {
  fetchCompanionAuthConfig,
  registerCompanionDevice,
  type PairOidcSession,
  type AuthFetcher,
} from "@/lib/tauri/companion-auth"
import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import { getActiveLogtoSession, signInToLogto } from "@/lib/logto/app-session"
import { createLogtoWebPopupDrivers } from "@/lib/logto/web-popup"

export type PairRegistrationResult =
  | { kind: "ok"; config: CompanionConfig }
  | { kind: "invalid_payload"; message: string }
  | { kind: "registration_error"; message: string }

export async function registerPairPayload(
  rawPayload: string,
  fetcher?: AuthFetcher
): Promise<PairRegistrationResult> {
  const decoded = decodePairPayload(rawPayload)
  if (decoded.kind !== "ok") {
    return {
      kind: "invalid_payload",
      message:
        decoded.kind === "version_mismatch"
          ? `unsupported pairing payload version ${decoded.got}`
          : decoded.kind === "invalid"
            ? decoded.message
            : "invalid pairing payload",
    }
  }
  return registerDecodedPairPayload(decoded.payload, fetcher)
}

export async function registerDecodedPairPayload(
  payload: PairPayload,
  fetcher?: AuthFetcher
): Promise<PairRegistrationResult> {
  try {
    const oidc = payload.mode === "oidc" ? await resolveOidcSession(payload, fetcher) : null
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
      fetcher
    )
    config.targetId = payload.hostId
    return { kind: "ok", config }
  } catch (error) {
    return {
      kind: "registration_error",
      message: error instanceof Error ? error.message : String(error),
    }
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
