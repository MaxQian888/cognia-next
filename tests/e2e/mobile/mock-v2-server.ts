/**
 * Canonical Companion headless mock for browser/mobile E2E tests.
 *
 * The mock intentionally implements the public cgnp3 device-key flow rather
 * than a bearer shortcut: challenge, P-256 registration, five-minute
 * DPoP-bound access tokens, exact-path DPoP verification, single-use socket
 * tickets, and `/api/_rpc/:command`. Test-only control routes live outside the
 * public `/api` and `/ws` namespaces.
 */

import {
  createECDH,
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify as verifySignature,
} from "node:crypto"
import type { Server } from "node:http"

import { MOBILE_OUTBOUND_COMMANDS } from "../../../lib/db/mobile-outbound-types"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const createExpressApp = () => require("express")() as import("express").Application

export const MOCK_COMPANION_HOST_ID = "e2e-companion-host"
export const MOCK_COMPANION_TENANT_ID = "local_acct_a"
export const MOCK_OWNER_INVITATION_PREFIX = "e2e-owner-invitation-"

const ACCESS_TOKEN_TTL_SECONDS = 5 * 60
const SOCKET_TICKET_TTL_SECONDS = 60
const PROOF_CLOCK_SKEW_SECONDS = 60
const DEFAULT_ALLOWED_ORIGINS = new Set(["http://localhost:3000", "http://127.0.0.1:3000"])
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "DELETE"])
const ALLOWED_HEADERS = new Set([
  "accept",
  "authorization",
  "content-type",
  "dpop",
  "idempotency-key",
])

export interface RpcCapture {
  command: string
  body: unknown
  idempotencyKey: string | null
}

export interface RegisterRequestPayload {
  tenantId: string
  invitation?: string
  challengeId: string
  challengeNonce: string
  deviceId: string
  displayName: string
  publicKeyPem: string
  signalingPublicKey: string
  proof: string
}

export type PairScenario =
  | { kind: "ok"; serverVersion?: string }
  | { kind: "invalid-invitation" }
  | { kind: "expired"; status?: number; message?: string }
  | { kind: "server-error"; status: number; message: string }
  | { kind: "unreachable" }

export interface MockCompanionServer {
  start(port?: number): Promise<void>
  stop(): Promise<void>
  readonly port: number
  readonly baseUrl: string
  setPairScenario(scenario: PairScenario): void
  setStatusResponse(status: "ok" | "expired" | "offline"): void
  waitForRegistration(timeoutMs?: number): Promise<RegisterRequestPayload>
  readonly registrationAttempts: RegisterRequestPayload[]
  readonly rpcCalls: RpcCapture[]
  reset(): void
}

interface ChallengeRecord {
  tenantId: string
  nonce: string
  expiresAt: number
  consumed: boolean
}

interface DeviceRecord {
  tenantId: string
  publicKeyPem: string
  revoked: boolean
}

interface AccessRecord {
  token: string
  tenantId: string
  deviceId: string
  jti: string
  expiresAt: number
}

interface SocketTicketRecord {
  path: string
  audience: string
  expiresAt: number
  consumed: boolean
}

export function createMockCompanionServer(): MockCompanionServer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = createExpressApp() as any
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const express = require("express") as typeof import("express")
  app.use(express.json({ limit: "1mb" }))

  app.use((req: RequestLike, res: ResponseLike, next: () => void) => {
    const origin = header(req, "origin")
    if (origin && !DEFAULT_ALLOWED_ORIGINS.has(origin)) {
      publicError(res, 403, "web_origin_forbidden", "the browser Origin is not allowed")
      return
    }
    res.setHeader(
      "Vary",
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
    )
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin)
    if (req.method === "OPTIONS") {
      const method = header(req, "access-control-request-method")?.toUpperCase() ?? ""
      const requestedHeaders = (header(req, "access-control-request-headers") ?? "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
      if (
        !ALLOWED_METHODS.has(method) ||
        requestedHeaders.some((value) => !ALLOWED_HEADERS.has(value))
      ) {
        publicError(res, 403, "cors_preflight_forbidden", "the browser preflight is not allowed")
        return
      }
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
      res.setHeader(
        "Access-Control-Allow-Headers",
        "authorization, dpop, content-type, accept, idempotency-key"
      )
      res.status(204).end()
      return
    }
    next()
  })

  let server: Server | null = null
  let currentPort = 0
  let pairScenario: PairScenario = { kind: "ok" }
  let statusResponse: "ok" | "expired" | "offline" = "ok"
  const challenges = new Map<string, ChallengeRecord>()
  const devices = new Map<string, DeviceRecord>()
  const accessTokens = new Map<string, AccessRecord>()
  const socketTickets = new Map<string, SocketTicketRecord>()
  const consumedProofs = new Set<string>()
  const consumedInvitations = new Set<string>()
  const registrationAttempts: RegisterRequestPayload[] = []
  const registrationResolvers: Array<(payload: RegisterRequestPayload) => void> = []
  const rpcCalls: RpcCapture[] = []
  const knownRpcCommands = new Set<string>([
    ...MOBILE_OUTBOUND_COMMANDS,
    "claude_sidecar_status",
  ])

  app.get("/api/auth/config", (_req: RequestLike, res: ResponseLike) => {
    res.json({
      deploymentMode: "single-user",
      hostId: MOCK_COMPANION_HOST_ID,
      tenantId: MOCK_COMPANION_TENANT_ID,
      signaling: {
        url: "wss://signaling.e2e.invalid/v2/signaling",
        iceServers: [{ urls: ["stun:stun.e2e.invalid:3478"] }],
      },
    })
  })

  app.post("/api/auth/device/challenge", (req: RequestLike, res: ResponseLike) => {
    const tenantId = String(req.body?.tenantId ?? MOCK_COMPANION_TENANT_ID)
    if (tenantId !== MOCK_COMPANION_TENANT_ID) {
      publicError(res, 400, "invalid_tenant", "the tenant is not available")
      return
    }
    const challengeId = randomUUID()
    const nonce = randomBytes(24).toString("base64url")
    const expiresAt = Date.now() + 60_000
    challenges.set(challengeId, { tenantId, nonce, expiresAt, consumed: false })
    res.json({ challengeId, nonce, expiresAt })
  })

  app.post("/api/auth/device/register", (req: RequestLike, res: ResponseLike) => {
    const body = req.body as unknown as RegisterRequestPayload
    registrationAttempts.push(body)
    registrationResolvers.shift()?.(body)

    if (pairScenario.kind === "unreachable") {
      res.socket?.destroy()
      return
    }
    if (pairScenario.kind === "server-error") {
      publicError(res, pairScenario.status, "server_error", pairScenario.message)
      return
    }
    if (pairScenario.kind === "expired") {
      publicError(
        res,
        pairScenario.status ?? 401,
        "invitation_expired",
        pairScenario.message ?? "Owner invitation has expired."
      )
      return
    }
    if (pairScenario.kind === "invalid-invitation") {
      publicError(res, 403, "owner_invitation_invalid", "Owner invitation is not valid.")
      return
    }
    if (
      body.tenantId !== MOCK_COMPANION_TENANT_ID ||
      typeof body.invitation !== "string" ||
      !body.invitation.startsWith(MOCK_OWNER_INVITATION_PREFIX) ||
      consumedInvitations.has(body.invitation)
    ) {
      publicError(res, 403, "owner_invitation_invalid", "Owner invitation is not valid.")
      return
    }
    const challenge = requireChallenge(body, res)
    if (!challenge) return
    try {
      verifyDpopProof({
        proof: body.proof,
        publicKeyPem: body.publicKeyPem,
        nonce: challenge.nonce,
        method: "POST",
        path: "/api/auth/device/register",
        replayCache: consumedProofs,
        consumeReplay: false,
      })
    } catch (error) {
      publicError(res, 401, "invalid_device_proof", errorMessage(error))
      return
    }
    challenge.consumed = true
    consumedInvitations.add(body.invitation)
    devices.set(body.deviceId, {
      tenantId: body.tenantId,
      publicKeyPem: body.publicKeyPem,
      revoked: false,
    })
    const roomDescriptor = createRoomDescriptor(body.signalingPublicKey)
    res.json({
      deviceId: body.deviceId,
      tenantId: body.tenantId,
      role: "owner",
      serverVersion: pairScenario.serverVersion ?? "1.0.0-e2e",
      signaling: { rendezvousId: roomDescriptor.roomId, roomDescriptor },
    })
  })

  app.post("/api/auth/token", (req: RequestLike, res: ResponseLike) => {
    const body = req.body as {
      tenantId: string
      deviceId: string
      challengeId: string
      challengeNonce: string
      proof: string
    }
    const device = devices.get(body.deviceId)
    if (!device || device.revoked || device.tenantId !== body.tenantId) {
      publicError(res, 401, "device_unavailable", "the device is unknown or revoked")
      return
    }
    const challenge = requireChallenge(body, res)
    if (!challenge) return
    try {
      verifyDpopProof({
        proof: body.proof,
        publicKeyPem: device.publicKeyPem,
        nonce: challenge.nonce,
        method: "POST",
        path: "/api/auth/token",
        replayCache: consumedProofs,
        consumeReplay: false,
      })
    } catch (error) {
      publicError(res, 401, "invalid_device_proof", errorMessage(error))
      return
    }
    challenge.consumed = true
    const jti = randomUUID()
    const expiresAt = Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1_000
    const token = unsignedTestJwt({
      sub: body.deviceId,
      tenant_id: body.tenantId,
      scope: "device",
      iat: Math.floor(Date.now() / 1_000),
      exp: Math.floor(expiresAt / 1_000),
      jti,
    })
    accessTokens.set(token, {
      token,
      tenantId: body.tenantId,
      deviceId: body.deviceId,
      jti,
      expiresAt,
    })
    res.json({ accessToken: token, tokenType: "DPoP", expiresIn: ACCESS_TOKEN_TTL_SECONDS })
  })

  app.post("/api/auth/socket-ticket", (req: RequestLike, res: ResponseLike) => {
    const access = authenticateAccess(req, res, "/api/auth/socket-ticket", devices, accessTokens, consumedProofs)
    if (!access) return
    const channel = String(req.body?.channel ?? "")
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : null
    const binding = socketBinding(channel, sessionId)
    if (!binding) {
      publicError(res, 400, "socket_ticket_resource_forbidden", "invalid socket channel binding")
      return
    }
    const ticket = randomBytes(32).toString("base64url")
    socketTickets.set(ticket, {
      ...binding,
      expiresAt: Date.now() + SOCKET_TICKET_TTL_SECONDS * 1_000,
      consumed: false,
    })
    res.json({ ticket, expiresIn: SOCKET_TICKET_TTL_SECONDS })
  })

  app.get("/api/whoami", (req: RequestLike, res: ResponseLike) => {
    const access = authenticateAccess(req, res, "/api/whoami", devices, accessTokens, consumedProofs)
    if (!access) return
    res.json({
      deviceId: access.deviceId,
      accountId: access.tenantId,
      serverVersion: "1.0.0-e2e",
      tlsFingerprint: null,
    })
  })

  app.post("/api/_rpc/:command", (req: RequestLike, res: ResponseLike) => {
    const command = String(req.params?.command ?? "")
    const path = `/api/_rpc/${encodeURIComponent(command)}`
    const access = authenticateAccess(req, res, path, devices, accessTokens, consumedProofs)
    if (!access) return
    if (statusResponse === "expired") {
      publicError(res, 401, "invalid_access_token", "the access token is invalid or expired")
      return
    }
    if (statusResponse === "offline") {
      publicError(res, 503, "sidecar_offline", "the Headless runtime is unavailable")
      return
    }
    rpcCalls.push({
      command,
      body: req.body,
      idempotencyKey: header(req, "idempotency-key") ?? null,
    })
    if (!knownRpcCommands.has(command)) {
      publicError(res, 404, "unknown_command", `Unknown command: ${command}`)
      return
    }
    const result = command === "claude_sidecar_status" ? { status: "ok" } : {}
    res.json({ requestId: randomUUID(), result })
  })

  app.post("/__control/devices", (req: RequestLike, res: ResponseLike) => {
    const deviceId = String(req.body?.deviceId ?? "")
    const tenantId = String(req.body?.tenantId ?? MOCK_COMPANION_TENANT_ID)
    const publicKeyPem = String(req.body?.publicKeyPem ?? "")
    try {
      createPublicKey(publicKeyPem)
    } catch {
      publicError(res, 400, "invalid_public_key", "a valid P-256 public key is required")
      return
    }
    devices.set(deviceId, { tenantId, publicKeyPem, revoked: false })
    res.status(204).end()
  })

  app.post("/__control/revoke/:deviceId", (req: RequestLike, res: ResponseLike) => {
    const device = devices.get(String(req.params?.deviceId ?? ""))
    if (device) device.revoked = true
    res.status(204).end()
  })

  app.post("/__control/redeem-ticket", (req: RequestLike, res: ResponseLike) => {
    const ticket = socketTickets.get(String(req.body?.ticket ?? ""))
    if (
      !ticket ||
      ticket.consumed ||
      ticket.expiresAt <= Date.now() ||
      ticket.path !== req.body?.path ||
      ticket.audience !== req.body?.audience
    ) {
      publicError(res, 401, "invalid_socket_ticket", "the socket ticket is invalid or consumed")
      return
    }
    ticket.consumed = true
    res.status(204).end()
  })

  app.get("/__control/rpc-calls", (_req: RequestLike, res: ResponseLike) => res.json(rpcCalls))

  function requireChallenge(
    body: { tenantId: string; challengeId: string; challengeNonce: string },
    res: ResponseLike
  ): ChallengeRecord | null {
    const challenge = challenges.get(body.challengeId)
    if (
      !challenge ||
      challenge.consumed ||
      challenge.expiresAt <= Date.now() ||
      challenge.tenantId !== body.tenantId ||
      challenge.nonce !== body.challengeNonce
    ) {
      publicError(res, 401, "invalid_device_challenge", "the device challenge is invalid or consumed")
      return null
    }
    return challenge
  }

  return {
    async start(port = 0): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const listeningServer = app.listen(port)
        server = listeningServer
        listeningServer.once("listening", () => {
          const address = listeningServer.address()
          currentPort = typeof address === "object" && address ? address.port : port
          resolve()
        })
        listeningServer.once("error", reject)
      })
    },
    async stop(): Promise<void> {
      if (!server) return
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()))
      })
      server = null
    },
    get port() {
      return currentPort
    },
    get baseUrl() {
      return `http://127.0.0.1:${currentPort}`
    },
    setPairScenario(scenario) {
      pairScenario = scenario
    },
    setStatusResponse(value) {
      statusResponse = value
    },
    waitForRegistration(timeoutMs = 5_000): Promise<RegisterRequestPayload> {
      if (registrationAttempts.length > 0) {
        return Promise.resolve(registrationAttempts[registrationAttempts.length - 1]!)
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`waitForRegistration timed out after ${timeoutMs} ms`)),
          timeoutMs
        )
        registrationResolvers.push((payload) => {
          clearTimeout(timer)
          resolve(payload)
        })
      })
    },
    get registrationAttempts() {
      return registrationAttempts
    },
    get rpcCalls() {
      return rpcCalls
    },
    reset() {
      pairScenario = { kind: "ok" }
      statusResponse = "ok"
      challenges.clear()
      devices.clear()
      accessTokens.clear()
      socketTickets.clear()
      consumedProofs.clear()
      consumedInvitations.clear()
      registrationAttempts.length = 0
      registrationResolvers.length = 0
      rpcCalls.length = 0
    },
  }
}

interface RequestLike {
  method: string
  body?: Record<string, unknown>
  params?: Record<string, string>
  headers?: Record<string, string | string[] | undefined>
  header?: (name: string) => string | undefined
}

interface ResponseLike {
  socket?: { destroy(): void }
  status(code: number): ResponseLike
  setHeader(name: string, value: string): void
  json(body: unknown): void
  end(): void
}

function authenticateAccess(
  req: RequestLike,
  res: ResponseLike,
  path: string,
  devices: Map<string, DeviceRecord>,
  accessTokens: Map<string, AccessRecord>,
  consumedProofs: Set<string>
): AccessRecord | null {
  const authorization = header(req, "authorization")
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : ""
  const access = accessTokens.get(token)
  const device = access ? devices.get(access.deviceId) : undefined
  if (!access || access.expiresAt <= Date.now() || !device || device.revoked) {
    publicError(res, 401, "invalid_access_token", "the access token is invalid or expired")
    return null
  }
  const proof = header(req, "dpop")
  if (!proof) {
    publicError(res, 401, "missing_device_proof", "a DPoP device proof is required")
    return null
  }
  try {
    verifyDpopProof({
      proof,
      publicKeyPem: device.publicKeyPem,
      nonce: access.jti,
      method: req.method,
      path,
      replayCache: consumedProofs,
      consumeReplay: true,
    })
  } catch (error) {
    publicError(res, 401, "invalid_device_proof", errorMessage(error))
    return null
  }
  return access
}

function verifyDpopProof(input: {
  proof: string
  publicKeyPem: string
  nonce: string
  method: string
  path: string
  replayCache: Set<string>
  consumeReplay: boolean
}): void {
  const parts = input.proof.split(".")
  if (parts.length !== 3) throw new Error("DPoP proof is malformed")
  const headerValue = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as {
    alg?: string
    typ?: string
  }
  const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
    nonce?: string
    htm?: string
    htu?: string
    iat?: number
    exp?: number
    jti?: string
  }
  const now = Math.floor(Date.now() / 1_000)
  if (headerValue.alg !== "ES256" || headerValue.typ !== "dpop+jwt") {
    throw new Error("DPoP algorithm or type is invalid")
  }
  if (
    claims.nonce !== input.nonce ||
    claims.htm !== input.method.toUpperCase() ||
    claims.htu !== input.path
  ) {
    throw new Error("DPoP nonce, method, or path binding is invalid")
  }
  if (
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number" ||
    claims.iat > now + PROOF_CLOCK_SKEW_SECONDS ||
    claims.exp < now ||
    claims.exp - claims.iat > PROOF_CLOCK_SKEW_SECONDS
  ) {
    throw new Error("DPoP proof is expired")
  }
  if (!claims.jti || (input.consumeReplay && input.replayCache.has(claims.jti))) {
    throw new Error("DPoP proof was replayed")
  }
  const valid = verifySignature(
    "sha256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key: createPublicKey(input.publicKeyPem), dsaEncoding: "ieee-p1363" },
    Buffer.from(parts[2]!, "base64url")
  )
  if (!valid) throw new Error("DPoP signature is invalid")
  if (input.consumeReplay) input.replayCache.add(claims.jti)
}

function createRoomDescriptor(mobileSigningKey: string) {
  const host = createECDH("prime256v1")
  host.generateKeys()
  const desktopSigningKey = host.getPublicKey().toString("base64url")
  const roomNonce = randomBytes(16).toString("base64url")
  const notAfter = Date.now() + 60 * 60 * 1_000
  const fields = ["2", roomNonce, desktopSigningKey, mobileSigningKey, String(notAfter)]
  const encoded = Buffer.concat(
    fields.map((value) => {
      const bytes = Buffer.from(value)
      const size = Buffer.alloc(4)
      size.writeUInt32BE(bytes.length)
      return Buffer.concat([size, bytes])
    })
  )
  return {
    v: 2,
    roomId: createHash("sha256").update(encoded).digest("base64url"),
    roomNonce,
    desktopSigningKey,
    mobileSigningKey,
    notAfter,
  }
}

function socketBinding(
  channel: string,
  sessionId: string | null
): { path: string; audience: string } | null {
  if (channel === "events" && sessionId === null) return { path: "/ws/events", audience: "events" }
  if (channel === "terminal" && sessionId === null) {
    return { path: "/ws/terminal", audience: "terminal" }
  }
  if (channel === "acp" && sessionId === null) return { path: "/ws/acp", audience: "acp" }
  if (channel === "browser" && sessionId) {
    return { path: `/ws/browser/${sessionId}`, audience: "browser" }
  }
  return null
}

function unsignedTestJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    randomBytes(32).toString("base64url"),
  ].join(".")
}

function header(req: RequestLike, name: string): string | undefined {
  if (typeof req.header === "function") return req.header(name)
  const value = req.headers?.[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function publicError(res: ResponseLike, status: number, code: string, message: string): void {
  res.status(status).json({
    error: { code, message, requestId: randomUUID(), retryable: status >= 500, details: {} },
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
