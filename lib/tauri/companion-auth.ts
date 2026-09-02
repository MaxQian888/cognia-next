import { pinnedFetch, type PinnedFetchInit } from "./pinned-fetch"
import type { CompanionConfig } from "./companion-storage"
import { generatePersistableSigningIdentity, type RoomDescriptor } from "@/lib/signaling/crypto"
import { APP_VERSION } from "@/lib/app-version"
import { requireJwtPayload } from "@/lib/security/jwt-payload"
import { isLoopbackHostname } from "@/lib/connectivity/loopback-hostname"

/** A social sign-in method the deployment enabled at Logto. */
export interface CompanionAuthSocialProvider {
  /** The Logto connector's identity-provider name, e.g. `github`, `feishu`. */
  provider: string
  /** The `direct_sign_in` value for the authorize request, e.g. `social:github`. */
  directSignIn: string
}

export type CompanionAuthCallbackMode = "web-popup" | "native-loopback" | "deep-link"

export interface CompanionAuthConfig {
  /**
   * Version 1 servers omit it. Every later version only ADDS fields, so a
   * client reads whatever is present and never branches on the number.
   */
  configVersion?: number
  deploymentMode: "single-user" | "multi-tenant"
  hostId: string
  tenantId?: string
  oidc?: {
    issuer: string
    audience: string
    webClientId: string
    /** The Logto "native" application (desktop + CLI). Version 2. */
    nativeClientId?: string
    scopes: string[]
    /** Version 2. Absent or empty means the universal Logto page only. */
    socialProviders?: CompanionAuthSocialProvider[]
    /** Version 2. */
    callbackModes?: CompanionAuthCallbackMode[]
  }
  signaling: {
    url: string
    iceServers: RTCIceServer[]
  }
  /** Version 2. Present when the deployment enrols accounts on a collaboration server. */
  collaboration?: {
    serviceUrl: string
    registrationPolicy: "bootstrap-then-invite"
  }
}

/**
 * The social providers a config advertises, with anything malformed dropped.
 *
 * Defensive on purpose: a version-2 server is trusted for the shape, but a
 * proxy or a hand-edited mock is not, and one bad row must not hide the good
 * ones or crash the sign-in screen.
 */
export function authConfigSocialProviders(
  config: Pick<CompanionAuthConfig, "oidc">
): CompanionAuthSocialProvider[] {
  const raw = config.oidc?.socialProviders
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const providers: CompanionAuthSocialProvider[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const { provider, directSignIn } = entry as Partial<CompanionAuthSocialProvider>
    if (typeof provider !== "string" || typeof directSignIn !== "string") continue
    const name = provider.trim().toLowerCase()
    if (!name || seen.has(name) || !/^[a-z0-9_-]+:[a-z0-9_.-]+$/i.test(directSignIn)) continue
    seen.add(name)
    providers.push({ provider: name, directSignIn: directSignIn.trim() })
  }
  return providers
}

/** The collaboration service a config names, or `null` when it names none. */
export function authConfigCollaborationServiceUrl(
  config: Pick<CompanionAuthConfig, "collaboration">
): string | null {
  const url = config.collaboration?.serviceUrl
  if (typeof url !== "string" || !url.trim()) return null
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null
    return parsed.toString().replace(/\/$/, "")
  } catch {
    return null
  }
}

export interface PairOidcSession {
  issuer: string
  clientId: string
  resource: string
  organizationId?: string
  accessToken: string
}

export interface DeviceIdentity {
  deviceId: string
  privateKeyJwk: JsonWebKey
  publicKeyPem: string
  thumbprint: string
}

interface Challenge {
  challengeId: string
  nonce: string
  expiresAt: number
}

interface TokenState {
  accessToken: string
  jti: string
  expiresAt: number
}

export type AuthFetcher = (url: string, init: PinnedFetchInit) => Promise<Response>
export type SocketTicketRequest =
  { channel: "events" | "terminal" | "acp" | "worker" } | { channel: "browser"; sessionId: string }
const tokens = new Map<string, TokenState>()

export async function generateDeviceIdentity(): Promise<DeviceIdentity> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  const [privateKeyJwk, spki] = await Promise.all([
    crypto.subtle.exportKey("jwk", pair.privateKey),
    crypto.subtle.exportKey("spki", pair.publicKey),
  ])
  const publicKeyPem = spkiToPem(spki)
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(publicKeyPem))
  return {
    deviceId: crypto.randomUUID(),
    privateKeyJwk,
    publicKeyPem,
    thumbprint: bytesToHex(new Uint8Array(digest)),
  }
}

/**
 * The paired-device platform label this client reports at registration —
 * the same vocabulary `lib/companion/event-bridge.ts` normalises on receipt
 * (`ios` | `android` | `web` | `unknown`).
 */
export function devicePlatformLabel(): "ios" | "android" | "web" | "unknown" {
  if (typeof window === "undefined") return "unknown"
  const cap = (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor
  const native = typeof cap?.getPlatform === "function" ? cap.getPlatform() : null
  if (native === "ios" || native === "android") return native
  if (native === "web" || !("__TAURI_INTERNALS__" in window)) return "web"
  return "unknown"
}

export async function registerCompanionDevice(
  input: {
    baseUrl: string
    mode: "owner-invitation" | "oidc"
    invitation?: string
    hostId: string
    tenantId: string
    displayName: string
    serverVersion: string
    serverFingerprint?: string
    oidc?: PairOidcSession
  },
  fetcher: AuthFetcher = pinnedFetch
): Promise<CompanionConfig> {
  const authConfig = await fetchCompanionAuthConfig(input.baseUrl, input.serverFingerprint, fetcher)
  validateRegistrationContext(input, authConfig)
  const identity = await generateDeviceIdentity()
  const signalingIdentity = await generatePersistableSigningIdentity()
  const challenge = await requestChallenge(
    input.baseUrl,
    input.tenantId,
    input.serverFingerprint,
    fetcher
  )
  const proof = await createDeviceProof(
    identity.privateKeyJwk,
    challenge.nonce,
    "POST",
    "/api/auth/device/register"
  )
  const registration = await expectJson(
    fetcher(`${trimSlash(input.baseUrl)}/api/auth/device/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(input.mode === "oidc" ? { Authorization: `Bearer ${input.oidc!.accessToken}` } : {}),
      },
      body: JSON.stringify({
        tenantId: input.tenantId,
        ...(input.mode === "owner-invitation" ? { invitation: input.invitation } : {}),
        challengeId: challenge.challengeId,
        challengeNonce: challenge.nonce,
        deviceId: identity.deviceId,
        displayName: input.displayName,
        publicKeyPem: identity.publicKeyPem,
        signalingPublicKey: signalingIdentity.encodedPublicKey,
        proof,
        // ADR-0127: self-reported so the host's `companion://device-paired`
        // event (consumed by every other paired client) can label the device.
        // Older hosts ignore unknown fields.
        platform: devicePlatformLabel(),
        appVersion: APP_VERSION,
      }),
      serverFingerprint: input.serverFingerprint,
    })
  )
  const signaling = parseSignalingRegistration(registration, signalingIdentity.encodedPublicKey)
  if (registration.deviceId !== identity.deviceId || registration.tenantId !== input.tenantId) {
    throw new Error("device registration response does not match the requested identity")
  }
  const config: CompanionConfig = {
    baseUrl: trimSlash(input.baseUrl),
    deviceId: identity.deviceId,
    devicePrivateKeyJwk: identity.privateKeyJwk,
    deviceKeyThumbprint: identity.thumbprint,
    tenantId: registration.tenantId,
    serverVersion:
      typeof registration.serverVersion === "string"
        ? registration.serverVersion
        : input.serverVersion,
    serverFingerprint: input.serverFingerprint,
    rendezvousId: signaling.rendezvousId,
    signalingRoomDescriptor: signaling.roomDescriptor,
    signalingPrivateKeyJwk: signalingIdentity.privateKeyJwk,
    signalingUrl: authConfig.signaling.url,
    iceServers: authConfig.signaling.iceServers,
  }
  await refreshAccessToken(config, fetcher)
  return config
}

/** Register a least-privilege execution worker from a one-time Owner-issued enrollment. */
export async function registerCompanionWorker(
  input: {
    baseUrl: string
    tenantId: string
    enrollment: string
    displayName: string
    serverFingerprint?: string
  },
  fetcher: AuthFetcher = pinnedFetch
): Promise<CompanionConfig> {
  const identity = await generateDeviceIdentity()
  const challenge = await requestChallenge(
    input.baseUrl,
    input.tenantId,
    input.serverFingerprint,
    fetcher
  )
  const path = "/api/auth/worker/register"
  const proof = await createDeviceProof(identity.privateKeyJwk, challenge.nonce, "POST", path)
  const registration = await expectJson(
    fetcher(`${trimSlash(input.baseUrl)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: input.tenantId,
        enrollment: input.enrollment,
        challengeId: challenge.challengeId,
        challengeNonce: challenge.nonce,
        deviceId: identity.deviceId,
        displayName: input.displayName,
        publicKeyPem: identity.publicKeyPem,
        proof,
      }),
      serverFingerprint: input.serverFingerprint,
    })
  )
  if (
    registration.deviceId !== identity.deviceId ||
    registration.tenantId !== input.tenantId ||
    registration.role !== "member" ||
    !Array.isArray(registration.capabilities) ||
    registration.capabilities.length !== 1 ||
    registration.capabilities[0] !== "agent.worker"
  ) {
    throw new Error("worker registration response is malformed or over-privileged")
  }
  const config: CompanionConfig = {
    baseUrl: trimSlash(input.baseUrl),
    deviceId: identity.deviceId,
    devicePrivateKeyJwk: identity.privateKeyJwk,
    deviceKeyThumbprint: identity.thumbprint,
    tenantId: input.tenantId,
    serverVersion:
      typeof registration.serverVersion === "string" ? registration.serverVersion : "unknown",
    serverFingerprint: input.serverFingerprint,
  }
  await refreshAccessToken(config, fetcher)
  return config
}

export async function fetchCompanionAuthConfig(
  baseUrl: string,
  serverFingerprint: string | undefined,
  fetcher: AuthFetcher = pinnedFetch
): Promise<CompanionAuthConfig> {
  const body = await expectJson(
    fetcher(`${trimSlash(baseUrl)}/api/auth/config`, {
      method: "GET",
      headers: { Accept: "application/json" },
      serverFingerprint,
    })
  )
  if (
    (body.deploymentMode !== "single-user" && body.deploymentMode !== "multi-tenant") ||
    typeof body.hostId !== "string" ||
    !isSignalingConfig(body.signaling)
  ) {
    throw new Error("companion auth config response is malformed")
  }
  return body as unknown as CompanionAuthConfig
}

function validateRegistrationContext(
  input: {
    mode: "owner-invitation" | "oidc"
    invitation?: string
    hostId: string
    tenantId: string
    oidc?: PairOidcSession
  },
  config: CompanionAuthConfig
): void {
  if (config.hostId !== input.hostId) throw new Error("pairing payload Host does not match server")
  if (input.mode === "owner-invitation") {
    if (config.deploymentMode !== "single-user" || !input.invitation) {
      throw new Error("server does not accept Owner invitation pairing")
    }
    if (config.tenantId !== input.tenantId)
      throw new Error("pairing payload tenant does not match server")
    return
  }
  if (config.deploymentMode !== "multi-tenant" || !config.oidc || !input.oidc) {
    throw new Error("an active OIDC session is required for this pairing")
  }
  if (
    input.oidc.issuer !== config.oidc.issuer ||
    input.oidc.resource !== config.oidc.audience ||
    input.oidc.clientId !== config.oidc.webClientId
  ) {
    throw new Error("OIDC session issuer, resource, or client does not match server config")
  }
  if (input.oidc.organizationId !== input.tenantId) {
    throw new Error("OIDC organization does not match pairing tenant")
  }
}

function isSignalingConfig(value: unknown): value is CompanionAuthConfig["signaling"] {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return (
    typeof record.url === "string" &&
    isUsableSignalingUrl(record.url) &&
    Array.isArray(record.iceServers)
  )
}

/**
 * `wss://` anywhere, or `ws://` on this machine.
 *
 * A `^wss://` prefix test used to be the whole rule, which made the entire
 * auth-config response "malformed" the moment the Host answered honestly about
 * its plaintext loopback listener — the one plane a browser tab can reach it
 * on. The failure landed on `fetchCompanionAuthConfig`, so it read as "the
 * Host is broken" during pairing rather than "signaling is not available over
 * this transport".
 *
 * Cleartext signaling aimed off this machine stays refused: the rendezvous
 * carries the room descriptor, and that must not cross a shared network in the
 * clear. Same rule the Host's own `is_secure_or_loopback` applies.
 */
function isUsableSignalingUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol === "wss:") return true
  return url.protocol === "ws:" && isLoopbackHostname(url.hostname)
}

function parseSignalingRegistration(
  body: Record<string, unknown>,
  clientPublicKey: string
): { rendezvousId: string; roomDescriptor: RoomDescriptor } {
  const signaling = body.signaling as Record<string, unknown> | undefined
  const descriptor = signaling?.roomDescriptor as RoomDescriptor | undefined
  if (
    typeof signaling?.rendezvousId !== "string" ||
    !descriptor ||
    descriptor.v !== 2 ||
    descriptor.roomId !== signaling.rendezvousId ||
    descriptor.mobileSigningKey !== clientPublicKey ||
    descriptor.notAfter <= Date.now()
  ) {
    throw new Error("device registration signaling response is malformed")
  }
  return { rendezvousId: signaling.rendezvousId, roomDescriptor: descriptor }
}

export async function companionAuthorizationHeaders(
  config: CompanionConfig,
  method: string,
  path: string,
  fetcher: AuthFetcher = pinnedFetch
): Promise<Record<string, string>> {
  if (!config.devicePrivateKeyJwk) {
    if (config.serviceToken) return { Authorization: `Bearer ${config.serviceToken}` }
    throw new Error("companion device identity is unavailable; pair this device again")
  }
  let token = tokens.get(config.deviceId)
  if (!token || token.expiresAt - Date.now() < 30_000) {
    token = await refreshAccessToken(config, fetcher)
  }
  return {
    Authorization: `Bearer ${token.accessToken}`,
    DPoP: await createDeviceProof(config.devicePrivateKeyJwk, token.jti, method, path),
  }
}

export async function issueSocketTicket(
  config: CompanionConfig,
  request: SocketTicketRequest | "events" | "terminal" | "acp" | "worker",
  fetcher: AuthFetcher = pinnedFetch
): Promise<{ ticket: string; expiresAt: number }> {
  const payload: SocketTicketRequest = typeof request === "string" ? { channel: request } : request
  if (payload.channel === "browser" && payload.sessionId.trim() === "") {
    throw new Error("browser socket tickets require a sessionId")
  }
  const path = "/api/auth/socket-ticket"
  const headers = await companionAuthorizationHeaders(config, "POST", path, fetcher)
  const body = await expectJson(
    fetcher(`${trimSlash(config.baseUrl)}${path}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      serverFingerprint: config.serverFingerprint,
    })
  )
  const ticket = body.ticket
  const expiresIn = body.expiresIn
  if (typeof ticket !== "string" || typeof expiresIn !== "number") {
    throw new Error("socket ticket response is malformed")
  }
  return { ticket, expiresAt: Date.now() + expiresIn * 1_000 }
}

export function clearCompanionAccessTokens(): void {
  tokens.clear()
}

export function invalidateCompanionAccessToken(deviceId: string): void {
  tokens.delete(deviceId)
}

async function refreshAccessToken(
  config: CompanionConfig,
  fetcher: AuthFetcher
): Promise<TokenState> {
  if (!config.devicePrivateKeyJwk) throw new Error("device private key is unavailable")
  const tenantId = config.tenantId ?? config.accountId ?? "local_acct_a"
  const challenge = await requestChallenge(
    config.baseUrl,
    tenantId,
    config.serverFingerprint,
    fetcher
  )
  const proof = await createDeviceProof(
    config.devicePrivateKeyJwk,
    challenge.nonce,
    "POST",
    "/api/auth/token"
  )
  const body = await expectJson(
    fetcher(`${trimSlash(config.baseUrl)}/api/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId,
        deviceId: config.deviceId,
        challengeId: challenge.challengeId,
        challengeNonce: challenge.nonce,
        proof,
      }),
      serverFingerprint: config.serverFingerprint,
    })
  )
  if (typeof body.accessToken !== "string" || typeof body.expiresIn !== "number") {
    throw new Error("access token response is malformed")
  }
  const claims = requireJwtPayload(body.accessToken, "access token is malformed")
  if (typeof claims.jti !== "string") throw new Error("access token is missing jti")
  const state = {
    accessToken: body.accessToken,
    jti: claims.jti,
    expiresAt: Date.now() + body.expiresIn * 1_000,
  }
  tokens.set(config.deviceId, state)
  return state
}

async function requestChallenge(
  baseUrl: string,
  tenantId: string,
  serverFingerprint: string | undefined,
  fetcher: AuthFetcher
): Promise<Challenge> {
  const body = await expectJson(
    fetcher(`${trimSlash(baseUrl)}/api/auth/device/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId }),
      serverFingerprint,
    })
  )
  if (
    typeof body.challengeId !== "string" ||
    typeof body.nonce !== "string" ||
    typeof body.expiresAt !== "number"
  ) {
    throw new Error("device challenge response is malformed")
  }
  return body as unknown as Challenge
}

async function createDeviceProof(
  privateKeyJwk: JsonWebKey,
  nonce: string,
  method: string,
  path: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    privateKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  )
  const now = Math.floor(Date.now() / 1_000)
  const header = base64UrlJson({ alg: "ES256", typ: "dpop+jwt" })
  const payload = base64UrlJson({
    nonce,
    htm: method.toUpperCase(),
    htu: path,
    iat: now,
    exp: now + 60,
    jti: crypto.randomUUID(),
  })
  const input = `${header}.${payload}`
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(input)
  )
  return `${input}.${base64UrlBytes(new Uint8Array(signature))}`
}

/**
 * A companion API refusal, carrying the machine-readable `code` alongside the
 * human message.
 *
 * The message alone is not enough to act on: two 403s with the same shape can
 * need opposite remedies (a missing capability wants a grant, a host-wide
 * switch wants the switch), and callers were left string-matching English
 * server copy to tell them apart. `message` is unchanged, so nothing that
 * already reads it moves.
 */
export class CompanionApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number
  ) {
    super(message)
    this.name = "CompanionApiError"
  }
}

/** The refusal code from a caught companion API error, when it has one. */
export function companionErrorCode(error: unknown): string | null {
  return error instanceof CompanionApiError ? error.code : null
}

async function expectJson(responsePromise: Promise<Response>): Promise<Record<string, unknown>> {
  const response = await responsePromise
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok) {
    const detail = body?.error as Record<string, unknown> | undefined
    throw new CompanionApiError(
      typeof detail?.message === "string" ? detail.message : `HTTP ${response.status}`,
      typeof detail?.code === "string" ? detail.code : "",
      response.status
    )
  }
  return body ?? {}
}

function spkiToPem(spki: ArrayBuffer): string {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(spki)))
  const lines = base64.match(/.{1,64}/g)?.join("\n") ?? base64
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----\n`
}

function base64UrlJson(value: unknown): string {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)))
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "")
}
