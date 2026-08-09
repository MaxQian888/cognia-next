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
    signaling: { url: "wss://host.example/v2/signaling", iceServers: [] },
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

it("normalizes registration failures", async () => {
  register.mockRejectedValue(new Error("invitation already consumed"))
  await expect(registerDecodedPairPayload(payload)).resolves.toEqual({
    kind: "registration_error",
    message: "invitation already consumed",
  })
})
