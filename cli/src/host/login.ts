/**
 * `cognia-agent host login`: turn this machine into a device the Host knows.
 *
 * The device wire is the only one that works off-loopback, and it is the only
 * one where the owner keeps control: an enrolled CLI shows up in the Device
 * Console with its own capability grants, and revoking it there is enough. So
 * pairing is the same flow a phone uses, not a private side door.
 *
 * The Host's public `/api/auth/config` supplies the host and tenant ids, so a
 * caller only has to know the endpoint and hold a pairing code.
 */

import {
  fetchCompanionAuthConfig,
  registerCompanionDevice,
  type AuthFetcher,
} from "@/lib/tauri/companion-auth"

import type { CliFailure } from "../cli/errors"
import { normalizeEndpoint, type HostRecord } from "./store"

export interface LoginInput {
  endpoint: string
  /** The owner invitation code, read from Settings then Companion on the host. */
  invitation: string
  displayName?: string
  /** Pins the host's TLS SubjectPublicKeyInfo for every later call. */
  serverFingerprint?: string
  tenantId?: string
  fetcher?: AuthFetcher
  /** Injected in tests so no real pairing is attempted. */
  fetchConfig?: typeof fetchCompanionAuthConfig
  register?: typeof registerCompanionDevice
}

export type LoginResult = { ok: true; record: HostRecord } | { ok: false; failure: CliFailure }

export async function loginHost(input: LoginInput): Promise<LoginResult> {
  const endpoint = normalizeEndpoint(input.endpoint)
  const fetchConfig = input.fetchConfig ?? fetchCompanionAuthConfig
  const register = input.register ?? registerCompanionDevice

  let config: Awaited<ReturnType<typeof fetchCompanionAuthConfig>>
  try {
    config = await fetchConfig(endpoint, input.serverFingerprint, input.fetcher)
  } catch (error) {
    return {
      ok: false,
      failure: {
        error: `cannot read the pairing configuration from ${endpoint}`,
        details: [error instanceof Error ? error.message : String(error)],
        cause: "network",
        fix: [
          "check the endpoint, and that the Companion API server is running on the host",
          "a self-signed host needs --fingerprint <sha256 hex> from its pairing screen",
        ],
        inspect: [`cognia-agent api request GET /api/auth/config --endpoint ${endpoint}`],
      },
    }
  }

  if (config.deploymentMode !== "single-user") {
    return {
      ok: false,
      failure: {
        error: `${endpoint} is a multi-tenant deployment, which pairs through OIDC rather than an invitation code`,
        cause: "auth",
        fix: ["cognia-agent logto login", "then add the host with --kind device --tenant <id>"],
      },
    }
  }

  const tenantId = input.tenantId ?? config.tenantId
  if (!tenantId) {
    return {
      ok: false,
      failure: {
        error: `${endpoint} did not name a tenant, and none was given`,
        cause: "auth",
        fix: ["pass --tenant <id>"],
      },
    }
  }

  try {
    const paired = await register(
      {
        baseUrl: endpoint,
        mode: "owner-invitation",
        invitation: input.invitation,
        hostId: config.hostId,
        tenantId,
        displayName: input.displayName ?? "Cognia CLI",
        serverVersion: String(config.configVersion ?? "unknown"),
        ...(input.serverFingerprint ? { serverFingerprint: input.serverFingerprint } : {}),
      },
      input.fetcher
    )
    return {
      ok: true,
      record: {
        kind: "device",
        endpoint,
        tenantId,
        deviceId: paired.deviceId,
        ...(paired.devicePrivateKeyJwk
          ? {
              devicePrivateKeyJwk: paired.devicePrivateKeyJwk as unknown as Record<string, unknown>,
            }
          : {}),
        ...(paired.deviceKeyThumbprint ? { deviceKeyThumbprint: paired.deviceKeyThumbprint } : {}),
        ...((paired.serverFingerprint ?? input.serverFingerprint)
          ? { serverFingerprint: paired.serverFingerprint ?? input.serverFingerprint }
          : {}),
        ...(paired.serverVersion ? { serverVersion: paired.serverVersion } : {}),
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      failure: {
        error: `pairing with ${endpoint} was refused`,
        details: [message],
        cause: "auth",
        fix: [
          "a pairing code is single-use and short-lived, so take a fresh one from the host",
          "Settings then Companion on the desktop, or the Device Console",
        ],
      },
    }
  }
}
