/** @jest-environment jsdom */

import { encodePairPayload } from "@/lib/qr/pair-payload"
import { fetchCompanionAuthConfig, registerCompanionDevice } from "@/lib/tauri/companion-auth"
import { getActiveLogtoSession, signInToLogto } from "@/lib/logto/app-session"

import { registerDecodedPairPayload, registerPairPayload } from "./pair-api"

jest.mock("@/lib/tauri/companion-auth", () => ({
  registerCompanionDevice: jest.fn(),
  fetchCompanionAuthConfig: jest.fn(),
}))
jest.mock("@/lib/logto/app-session", () => ({
  getActiveLogtoSession: jest.fn(),
  signInToLogto: jest.fn(),
}))
jest.mock("@/lib/logto/web-popup", () => ({ createLogtoWebPopupDrivers: () => ({}) }))
jest.mock("./pair-helpers", () => ({ getDeviceLabel: () => "Test phone" }))

const register = registerCompanionDevice as jest.MockedFunction<typeof registerCompanionDevice>
const activeSession = getActiveLogtoSession as jest.MockedFunction<typeof getActiveLogtoSession>
const authConfig = fetchCompanionAuthConfig as jest.MockedFunction<typeof fetchCompanionAuthConfig>
const signIn = signInToLogto as jest.MockedFunction<typeof signInToLogto>
const payload = {
  baseUrl: "https://host.local:27890",
  mode: "owner-invitation" as const,
  invitation: "owner-invitation",
  hostId: "host-1",
  tenantId: "tenant-1",
  expiresAt: Date.now() + 60_000,
  serverVersion: "1.2.3",
  fingerprint: "ab".repeat(32),
}
const config = {
  baseUrl: payload.baseUrl,
  deviceId: "device-1",
  devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "secret" },
  deviceKeyThumbprint: "thumbprint",
  accountId: payload.tenantId,
  serverVersion: payload.serverVersion,
}

beforeEach(() => {
  register.mockReset()
  activeSession.mockReset()
  authConfig.mockReset()
  signIn.mockReset()
})

it("registers the invitation through the canonical device-key flow", async () => {
  register.mockResolvedValue(config)
  await expect(registerPairPayload(encodePairPayload(payload))).resolves.toEqual({
    kind: "ok",
    config: { ...config, targetId: payload.hostId },
    path: "direct",
  })
  expect(register).toHaveBeenCalledWith(
    {
      baseUrl: payload.baseUrl,
      mode: payload.mode,
      invitation: payload.invitation,
      hostId: payload.hostId,
      tenantId: payload.tenantId,
      displayName: "Test phone",
      serverVersion: payload.serverVersion,
      serverFingerprint: payload.fingerprint,
    },
    undefined
  )
})

it("reuses the active OIDC session for an oidc pairing", async () => {
  const session = {
    issuer: "https://id.example/oidc",
    clientId: "web-client",
    resource: "https://host.example/api",
    organizationId: payload.tenantId,
    accessToken: "oidc-access",
    scopes: ["openid"],
  }
  activeSession.mockResolvedValue(session)
  register.mockResolvedValue(config)

  await registerDecodedPairPayload({ ...payload, mode: "oidc", invitation: undefined })

  expect(register).toHaveBeenCalledWith(
    expect.objectContaining({ mode: "oidc", invitation: undefined, oidc: session }),
    undefined
  )
})

it("starts canonical Logto PKCE when an oidc pairing has no active session", async () => {
  const session = {
    issuer: "https://id.example/oidc",
    clientId: "web-client",
    resource: "https://host.example/api",
    organizationId: payload.tenantId,
    accessToken: "oidc-access",
    scopes: ["openid"],
  }
  activeSession.mockResolvedValue(null)
  authConfig.mockResolvedValue({
    deploymentMode: "multi-tenant",
    hostId: payload.hostId,
    oidc: {
      issuer: session.issuer,
      audience: session.resource,
      webClientId: session.clientId,
      scopes: ["openid", "offline_access"],
    },
    signaling: { url: "wss://host.example/signaling", iceServers: [] },
  })
  signIn.mockResolvedValue(session)
  register.mockResolvedValue(config)

  await registerDecodedPairPayload({ ...payload, mode: "oidc", invitation: undefined })

  expect(signIn).toHaveBeenCalledWith(
    expect.objectContaining({
      issuer: session.issuer,
      clientId: session.clientId,
      resource: session.resource,
      organizationId: payload.tenantId,
    }),
    expect.any(Object)
  )
  expect(register).toHaveBeenCalledWith(expect.objectContaining({ oidc: session }), undefined)
})

it("rejects old and malformed payloads without registering", async () => {
  await expect(registerPairPayload("cgnp2|legacy")).resolves.toMatchObject({
    kind: "invalid_payload",
  })
  await expect(registerPairPayload("not-cognia")).resolves.toMatchObject({
    kind: "invalid_payload",
  })
  expect(register).not.toHaveBeenCalled()
})

it("normalizes registration failures and keeps the cause for classification", async () => {
  const cause = new Error("invitation already consumed")
  register.mockRejectedValue(cause)
  await expect(registerDecodedPairPayload(payload)).resolves.toEqual({
    kind: "registration_error",
    message: "invitation already consumed",
    error: cause,
    baseUrl: payload.baseUrl,
  })
})

it("hands the decode outcome back so the caller can name the exact payload fault", async () => {
  await expect(registerPairPayload("cgnp2|legacy")).resolves.toMatchObject({
    kind: "invalid_payload",
    outcome: { kind: "version_mismatch", got: 2 },
  })
  await expect(registerPairPayload("not-cognia")).resolves.toMatchObject({
    kind: "invalid_payload",
    outcome: { kind: "wrong_format" },
  })
})

describe("relay pairing path (ADR-0170)", () => {
  const relay = {
    url: "wss://signaling.test/signaling",
    room: {
      v: 2 as const,
      roomId: "room-1",
      roomNonce: "nonce",
      desktopSigningKey: "desktop",
      mobileSigningKey: "mobile",
      notAfter: Date.now() + 60_000,
    },
    mobilePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "d", x: "x", y: "y" },
  }

  it("falls back to the relay room when the Host does not answer directly", async () => {
    register.mockResolvedValue(config)
    const relayFetcher = jest.fn()
    const close = jest.fn()
    const createRelayFetcher = jest.fn(async () => ({ fetcher: relayFetcher, close }))
    const result = await registerPairPayload(encodePairPayload({ ...payload, relay }), undefined, {
      createRelayFetcher,
      probeDirect: async () => false,
    })
    expect(result).toEqual({
      kind: "ok",
      config: { ...config, targetId: payload.hostId, signalingUrl: relay.url },
      path: "relay",
    })
    expect(createRelayFetcher).toHaveBeenCalledWith(relay)
    // Registration ran through the relay's fetcher, and the room was left.
    expect(register.mock.calls[0][1]).toBe(relayFetcher)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("stays direct when the Host answers, even with a relay in the invitation", async () => {
    register.mockResolvedValue(config)
    const createRelayFetcher = jest.fn()
    const result = await registerPairPayload(encodePairPayload({ ...payload, relay }), undefined, {
      createRelayFetcher,
      probeDirect: async () => true,
    })
    expect(result).toMatchObject({ kind: "ok", path: "direct" })
    expect(createRelayFetcher).not.toHaveBeenCalled()
  })

  it("reports a relay room the Host never joined as a registration error", async () => {
    const result = await registerPairPayload(encodePairPayload({ ...payload, relay }), undefined, {
      createRelayFetcher: async () => {
        throw new Error("no peer joined the rendezvous within the wait window")
      },
      probeDirect: async () => false,
    })
    expect(result).toMatchObject({ kind: "registration_error", message: /no peer joined/ })
    expect(register).not.toHaveBeenCalled()
  })
})
