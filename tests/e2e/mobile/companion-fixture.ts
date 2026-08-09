import { createHash, randomUUID, webcrypto } from "node:crypto"

import { encodePairPayload } from "../../../lib/qr/pair-payload"
import type { CompanionConfig } from "../../../lib/tauri/companion-storage"
import {
  MOCK_COMPANION_HOST_ID,
  MOCK_COMPANION_TENANT_ID,
  MOCK_OWNER_INVITATION_PREFIX,
} from "./mock-v2-server"

const E2E_LOCAL_ACCOUNT_ID = "acct_e2e_seed_account"

export function createOwnerPairPayload(
  baseUrl: string,
  overrides: { hostId?: string; invitation?: string; expiresAt?: number } = {}
): string {
  return encodePairPayload({
    baseUrl,
    hostId: overrides.hostId ?? MOCK_COMPANION_HOST_ID,
    tenantId: MOCK_COMPANION_TENANT_ID,
    mode: "owner-invitation",
    invitation: overrides.invitation ?? `${MOCK_OWNER_INVITATION_PREFIX}${randomUUID()}`,
    expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
    serverVersion: "1.0.0-e2e",
    fingerprint: "",
  })
}

/**
 * Provision a canonical P-256 device directly through the mock's test-control
 * plane. Pairing specs use the public challenge/register flow; unrelated UI
 * specs use this helper to avoid repeating pairing as setup while retaining
 * the same DPoP token behavior on every public request.
 */
export async function provisionMockCompanionConfig(
  baseUrl: string,
  deviceId = `e2e-device-${randomUUID()}`
): Promise<CompanionConfig> {
  const pair = (await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair
  const [devicePrivateKeyJwk, spki] = await Promise.all([
    webcrypto.subtle.exportKey("jwk", pair.privateKey),
    webcrypto.subtle.exportKey("spki", pair.publicKey),
  ])
  const publicKeyPem = spkiToPem(spki)
  const response = await fetch(`${baseUrl}/__control/devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tenantId: MOCK_COMPANION_TENANT_ID,
      deviceId,
      publicKeyPem,
    }),
  })
  if (!response.ok) {
    throw new Error(`mock Companion device provisioning failed with HTTP ${response.status}`)
  }
  return {
    baseUrl,
    deviceId,
    devicePrivateKeyJwk,
    deviceKeyThumbprint: createHash("sha256").update(publicKeyPem).digest("hex"),
    tenantId: MOCK_COMPANION_TENANT_ID,
    serverVersion: "1.0.0-e2e",
  }
}

export function companionConfigSecureStorage(
  config: CompanionConfig
): Record<string, string> {
  if (!config.devicePrivateKeyJwk || !config.deviceKeyThumbprint) {
    throw new Error("a canonical device identity is required")
  }
  const accountNamespace = config.accountId ?? E2E_LOCAL_ACCOUNT_ID
  const hostId = config.targetId ?? config.deviceId
  const recordKey = `${encodeURIComponent(accountNamespace)}:${encodeURIComponent(hostId)}`
  const now = Date.now()
  return {
    "cognia.companion.hosts.v2": JSON.stringify({
      version: 2,
      hosts: {
        [recordKey]: {
          hostId,
          accountNamespace,
          tenantId: config.tenantId,
          label: hostId,
          endpoints: { baseUrl: config.baseUrl },
          tlsPin: config.serverFingerprint ?? null,
          cursorNamespace: recordKey,
          deviceId: config.deviceId,
          deviceKeyThumbprint: config.deviceKeyThumbprint,
          serverVersion: config.serverVersion,
          connection: {
            status: "unknown",
            generation: 0,
            lastOkAt: null,
            lastErrorAt: null,
            lastError: null,
          },
          createdAt: now,
          updatedAt: now,
        },
      },
      active: { [accountNamespace]: recordKey },
    }),
    [`companion-host:${recordKey}:device-private-jwk`]: JSON.stringify(
      config.devicePrivateKeyJwk
    ),
  }
}

function spkiToPem(spki: ArrayBuffer): string {
  const base64 = Buffer.from(spki).toString("base64")
  const lines = base64.match(/.{1,64}/g)?.join("\n") ?? base64
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----\n`
}
