/**
 * A stand-in for the Cognia Host's plaintext browser plane.
 *
 * ## Why a mock at all
 *
 * The real plane lives in `src-tauri/src/companion_api/` and needs a built
 * Tauri binary, a keyring, a SecurityStore and an app database. None of that
 * exists in a browser CI job, and shipping it there would buy fidelity for the
 * half of the contract that already has direct tests: `cargo test -p
 * cognia-next --lib companion_api` covers enrollment consumption, capability
 * assignment, origin binding and revocation from the Rust side.
 *
 * What has **no** other test is the extension's half — that a real Chrome
 * extension, with real WebCrypto and a real non-extractable key, produces
 * requests this plane accepts. That is what this server checks, and it checks
 * it by refusing anything the Rust would refuse rather than by accepting
 * whatever arrives.
 *
 * ## What is deliberately faithful
 *
 * Every rule below was read out of the Rust and is enforced here, because a
 * mock that only ever says yes turns an E2E into an expensive screenshot:
 *
 *  - **The proof is verified.** ES256 over `header.payload`, against the SPKI
 *    the extension registered. `htu` is the bare path, `htm` the method, and
 *    `nonce` is the challenge nonce before a token exists and the token's
 *    `jti` after (`api.rs::verify_device_proof`).
 *  - **Enrollments are single-use**, consumed in the same step that writes the
 *    device (`security_store.rs::register_browser_device`).
 *  - **The bound origin is replayed.** A browser device's every later request
 *    must carry the `Origin` it registered with; missing counts as mismatched,
 *    because `WebOriginPolicy` would otherwise classify it as `Native` and let
 *    it through (`api.rs::authenticate_device_request`).
 *  - **Idempotency is a declaration.** `browser_context_submit` declares
 *    `idempotency: "required"`, so a missing key is `400
 *    idempotency_key_required` and a key on a read is `400
 *    idempotency_key_forbidden`.
 *  - **The envelope is the envelope.** Success is `{ requestId, result }`,
 *    never the bare result, and failure is `{ error: { code, message, … } }`.
 *    Returning the result unwrapped here would have hidden the very bug the
 *    extension had.
 *
 * ## What is NOT modelled, and must not be read as covered
 *
 * There is no agent, no session transcript, no WorkSubmission ledger and no PII
 * gate. `browser_context_submit` records that a session would have been created
 * and hands back an id. So these specs can prove "one user action produced
 * exactly one session id", and cannot prove anything about what the Host then
 * does with it — that lives in `lib/browser-companion/service.test.ts` and in
 * the Rust suite.
 */
import { createHash, createPublicKey, randomUUID, verify as verifySignature } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { AddressInfo } from "node:net"

import {
  BROWSER_CONTEXT_LIMITS,
  encodeBrowserEnrollmentPayload,
  type BrowserCompanionAppearanceV1,
  type BrowserCompanionCapabilityV1,
  type BrowserCompanionWorkspaceV1,
  type BrowserContextSubmissionSummaryV1,
  type BrowserContextSubmitRequestV1,
  type BrowserSubmissionStatus,
} from "@cognia/companion-client"

/** Mirrors `web_origin.rs::ALLOWED_HEADERS` — a superset fails differently. */
const ALLOWED_HEADERS = "authorization, dpop, content-type, accept, idempotency-key"

/** Mirrors `api.rs::ACCESS_TOKEN_TTL_SECS`. */
const ACCESS_TOKEN_TTL_SECS = 300

/** Mirrors `api.rs::PROOF_CLOCK_SKEW_SECS`. */
const PROOF_CLOCK_SKEW_SECS = 60

/** One request the server saw, for tests that assert on the wire. */
export interface RecordedRequest {
  method: string
  path: string
  origin: string | null
  idempotencyKey: string | null
  hasAuthorization: boolean
  hasProof: boolean
}

/** One submission the server accepted. */
export interface RecordedSubmission {
  submissionId: string
  sessionId: string
  workspaceId: string
  instruction: string
  captureMode: string
  sourceHost: string
  title: string
  /** The delivery target the panel named, absent when it named none. */
  targetId?: string
  /** The whole serialized request, so a test can assert on its size. */
  requestBytes: number
  /** Present only when the capture carried one. */
  selectionText?: string
  readableText?: string
  status: BrowserSubmissionStatus
  submittedAt: number
  updatedAt: number
}

export interface MockHostOptions {
  /** The `chrome-extension://<id>` allowed to reach this plane. */
  extensionOrigin: string
  tenantId?: string
  workspaces?: BrowserCompanionWorkspaceV1[]
  appearance?: BrowserCompanionAppearanceV1
  /** Advertised by `browser_companion_capability`; drives the panel's gate. */
  schemaVersion?: number
}

export interface MockHost {
  /** `http://127.0.0.1:<port>` — the plaintext plane, as the real code emits. */
  readonly baseUrl: string
  /** A fresh single-use `cgnb1|…` code. */
  issueEnrollment(options?: { expiresInMs?: number }): string
  /** Every request the server saw, oldest first. */
  requests(): RecordedRequest[]
  /** Every accepted submission, oldest first. */
  submissions(): RecordedSubmission[]
  /** Distinct session ids handed out. One user action must produce one. */
  sessionIds(): string[]
  /** Registered browser devices, by id. */
  devices(): { deviceId: string; extensionOrigin: string; capabilities: string[] }[]
  /** Move a submission along, as a real run would. */
  setStatus(submissionId: string, status: BrowserSubmissionStatus): void
  /** Make every later authenticated call answer `device_unavailable`. */
  revokeDevices(): void
  /** Refuse every connection, as a stopped Host would. */
  setUnreachable(unreachable: boolean): void
  /** Serve `GET /page/<name>` — capture fixtures live on the same origin. */
  servePage(name: string, html: string): string
  close(): Promise<void>
}

interface DeviceRecord {
  deviceId: string
  publicKeyPem: string
  extensionOrigin: string
  capabilities: string[]
  revoked: boolean
}

interface TokenRecord {
  deviceId: string
  jti: string
  expiresAt: number
}

const DEFAULT_APPEARANCE: BrowserCompanionAppearanceV1 = {
  mode: "light",
  cssVars: {
    "--background": "oklch(1 0 0)",
    "--foreground": "oklch(0.145 0 0)",
    "--muted-foreground": "oklch(0.556 0 0)",
    "--border": "oklch(0.922 0 0)",
    "--primary": "oklch(0.205 0 0)",
    "--primary-foreground": "oklch(0.985 0 0)",
  },
  radiusBaseRem: 0.625,
  pillRadiusPx: 9999,
  density: "comfortable",
}

const DEFAULT_WORKSPACES: BrowserCompanionWorkspaceV1[] = [
  { id: "workspace-research", label: "Research", isDefault: true },
  { id: "workspace-inbox", label: "Inbox", isDefault: false },
]

export async function startMockHost(options: MockHostOptions): Promise<MockHost> {
  const tenantId = options.tenantId ?? "tenant-e2e"
  const workspaces = options.workspaces ?? DEFAULT_WORKSPACES
  const appearance = options.appearance ?? DEFAULT_APPEARANCE
  const schemaVersion = options.schemaVersion ?? 1

  const challenges = new Map<string, { nonce: string; expiresAt: number }>()
  const enrollments = new Map<string, { expiresAt: number; spent: boolean }>()
  const devices = new Map<string, DeviceRecord>()
  const tokens = new Map<string, TokenRecord>()
  const submissions: RecordedSubmission[] = []
  const idempotency = new Map<string, unknown>()
  const requests: RecordedRequest[] = []
  const pages = new Map<string, string>()
  const seenProofIds = new Set<string>()
  let unreachable = false

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      response.writeHead(500, { "Content-Type": "application/json" })
      response.end(JSON.stringify(errorBody("internal", "the mock host threw")))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  const baseUrl = `http://127.0.0.1:${port}`

  function errorBody(code: string, message: string) {
    return {
      error: { code, message, requestId: randomUUID(), retryable: false, details: {} },
    }
  }

  function cors(request: IncomingMessage, response: ServerResponse): boolean {
    const origin = request.headers.origin
    // Exactly the registered extension, never `*`. A wildcard would let this
    // suite pass with an extension whose origin the Host would refuse.
    if (origin === options.extensionOrigin) {
      response.setHeader("Access-Control-Allow-Origin", origin)
      response.setHeader("Vary", "Origin")
    }
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
      response.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS)
      response.setHeader("Access-Control-Max-Age", "600")
      // Chrome refuses a private-network preflight without this, and the
      // failure surfaces as an opaque CORS error rather than as a refusal.
      if (request.headers["access-control-request-private-network"] === "true") {
        response.setHeader("Access-Control-Allow-Private-Network", "true")
      }
      response.writeHead(204)
      response.end()
      return true
    }
    return false
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (unreachable) {
      request.destroy()
      response.destroy()
      return
    }
    const path = new URL(request.url ?? "/", baseUrl).pathname
    if (cors(request, response)) return

    if (request.method === "GET" && pages.has(path)) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      response.end(pages.get(path))
      return
    }

    const body = await readJson(request)
    requests.push({
      method: request.method ?? "GET",
      path,
      origin: request.headers.origin ?? null,
      idempotencyKey: header(request, "idempotency-key"),
      hasAuthorization: header(request, "authorization") !== null,
      hasProof: header(request, "dpop") !== null,
    })

    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" })
      response.end(JSON.stringify(payload))
    }

    if (path === "/api/auth/device/challenge") return challengeRoute(send)
    if (path === "/api/auth/browser/register") return registerRoute(request, body, send)
    if (path === "/api/auth/token") return tokenRoute(body, send)
    if (path.startsWith("/api/_rpc/")) {
      return rpcRoute(request, path.slice("/api/_rpc/".length), body, send)
    }
    send(404, errorBody("not_found", `no route for ${path}`))
  }

  function challengeRoute(send: (status: number, payload: unknown) => void): void {
    const challengeId = randomUUID()
    const nonce = randomUUID()
    challenges.set(challengeId, { nonce, expiresAt: Date.now() + 120_000 })
    send(200, { challengeId, nonce, expiresAt: Date.now() + 120_000 })
  }

  function registerRoute(
    request: IncomingMessage,
    body: Record<string, unknown>,
    send: (status: number, payload: unknown) => void
  ): void {
    const enrollment = enrollments.get(String(body.enrollment))
    // Shape first, then consumption — the Rust checks the origin before it
    // spends the enrollment, precisely so a bad origin does not burn a code
    // and leave the user with no explanation.
    const extensionOrigin = normalizeExtensionOrigin(String(body.extensionOrigin ?? ""))
    if (!extensionOrigin) {
      send(400, errorBody("invalid_extension_origin", "extensionOrigin must be a bare origin"))
      return
    }
    if (!enrollment || enrollment.spent || enrollment.expiresAt <= Date.now()) {
      send(403, errorBody("browser_enrollment_required", "the enrollment is spent or expired"))
      return
    }
    const proof = verifyProof(String(body.publicKeyPem), String(body.proof), {
      nonce: String(body.challengeNonce),
      method: "POST",
      path: "/api/auth/browser/register",
    })
    if (!proof.ok) {
      send(proof.status, errorBody(proof.code, proof.message))
      return
    }
    if (!consumeChallenge(String(body.challengeId), String(body.challengeNonce))) {
      send(401, errorBody("challenge_unavailable", "the challenge is unknown or spent"))
      return
    }
    enrollment.spent = true
    const deviceId = String(body.deviceId)
    devices.set(deviceId, {
      deviceId,
      publicKeyPem: String(body.publicKeyPem),
      extensionOrigin,
      // The closed set the Rust grants, and nothing else. A test that wants to
      // prove a browser cannot run an agent reads this.
      capabilities: ["browser.submit", "browser.read-own"],
      revoked: false,
    })
    send(200, {
      deviceId,
      tenantId,
      role: "member",
      capabilities: ["browser.submit", "browser.read-own"],
      extensionOrigin,
      serverVersion: "mock",
    })
  }

  function tokenRoute(
    body: Record<string, unknown>,
    send: (status: number, payload: unknown) => void
  ): void {
    const device = devices.get(String(body.deviceId))
    if (!device || device.revoked) {
      send(401, errorBody("device_unavailable", "the device is unknown or revoked"))
      return
    }
    const proof = verifyProof(device.publicKeyPem, String(body.proof), {
      nonce: String(body.challengeNonce),
      method: "POST",
      path: "/api/auth/token",
    })
    if (!proof.ok) {
      send(proof.status, errorBody(proof.code, proof.message))
      return
    }
    if (!consumeChallenge(String(body.challengeId), String(body.challengeNonce))) {
      send(401, errorBody("challenge_unavailable", "the challenge is unknown or spent"))
      return
    }
    const jti = randomUUID()
    const expiresAt = Date.now() + ACCESS_TOKEN_TTL_SECS * 1_000
    tokens.set(jti, { deviceId: device.deviceId, jti, expiresAt })
    send(200, {
      accessToken: fakeJwt({ sub: device.deviceId, jti }),
      tokenType: "DPoP",
      expiresIn: ACCESS_TOKEN_TTL_SECS,
    })
  }

  function rpcRoute(
    request: IncomingMessage,
    command: string,
    body: Record<string, unknown>,
    send: (status: number, payload: unknown) => void
  ): void {
    const bearer = header(request, "authorization")?.replace(/^Bearer\s+/i, "")
    const jti = bearer ? readJwtId(bearer) : null
    const token = jti ? tokens.get(jti) : null
    if (!token || token.expiresAt <= Date.now()) {
      send(401, errorBody("token_invalid", "the access token is unknown or expired"))
      return
    }
    const device = devices.get(token.deviceId)
    if (!device || device.revoked) {
      send(401, errorBody("device_unavailable", "the device is unknown or revoked"))
      return
    }
    // Missing counts as mismatched. `WebOriginPolicy` reads an absent `Origin`
    // as `Native` and allows it, so a browser device that stops sending one
    // must be refused here or the binding is decorative.
    if (request.headers.origin !== device.extensionOrigin) {
      send(403, errorBody("device_origin_mismatch", "the request origin is not the bound origin"))
      return
    }
    const proof = verifyProof(device.publicKeyPem, header(request, "dpop") ?? "", {
      nonce: token.jti,
      method: "POST",
      path: `/api/_rpc/${command}`,
    })
    if (!proof.ok) {
      send(proof.status, errorBody(proof.code, proof.message))
      return
    }

    const idempotencyKey = header(request, "idempotency-key")
    const writes = command === "browser_context_submit"
    if (writes && !idempotencyKey) {
      send(400, errorBody("idempotency_key_required", `${command} requires an Idempotency-Key`))
      return
    }
    if (!writes && idempotencyKey) {
      send(400, errorBody("idempotency_key_forbidden", `${command} must not carry one`))
      return
    }

    const requestId = randomUUID()
    const ok = (result: unknown) => send(200, { requestId, result })

    switch (command) {
      case "browser_companion_capability":
        return ok({
          schemaVersion,
          limits: BROWSER_CONTEXT_LIMITS,
          supportedCaptureModes: ["metadata", "selection", "readable-page"],
          workspaces,
          appearance,
          // Rebuilt on every call, as the real Host does: the catalogue gains
          // the conversation a submission just started, and the panel re-reads
          // it after submitting for exactly that reason.
          deliveryTargets: deliveryTargets(),
        } satisfies BrowserCompanionCapabilityV1)
      case "browser_context_submit":
        return ok(acceptSubmission(body as unknown as BrowserContextSubmitRequestV1))
      case "browser_context_list":
        return ok({ items: summaries() })
      case "browser_context_get": {
        const row = submissions.find((item) => item.submissionId === body.submissionId)
        if (!row) return send(404, errorBody("submission_not_found", "no such submission"))
        return ok(summaryOf(row))
      }
      default:
        return send(404, errorBody("unknown_command", `no command named ${command}`))
    }
  }

  function acceptSubmission(request: BrowserContextSubmitRequestV1): unknown {
    const replayed = idempotency.get(request.submissionId)
    // The whole point of the key: a second arrival is the first answer again,
    // not a second session.
    if (replayed) return replayed
    const sessionId = `session-${submissions.length + 1}`
    const now = Date.now()
    const row: RecordedSubmission = {
      submissionId: request.submissionId,
      // An append reuses the conversation the target names, so one user action
      // still produces one session — which `sessionIds()` is asserted on.
      sessionId: appendTarget(request) ?? sessionId,
      workspaceId: request.workspaceId,
      ...(request.targetId ? { targetId: request.targetId } : {}),
      instruction: request.instruction,
      captureMode: request.context.captureMode,
      sourceHost: hostOf(request.context.url),
      title: request.suggestedTitle ?? request.context.title,
      requestBytes: Buffer.byteLength(JSON.stringify(request), "utf8"),
      selectionText: request.context.selection?.text,
      readableText: request.context.readableText?.text,
      status: "queued",
      submittedAt: now,
      updatedAt: now,
    }
    submissions.push(row)
    const response = {
      submissionId: row.submissionId,
      sessionId: row.sessionId,
      acceptedAt: now,
      status: "queued" satisfies BrowserSubmissionStatus,
      deepLink: `cognia://session/${row.sessionId}`,
    }
    idempotency.set(request.submissionId, response)
    return response
  }

  /**
   * The conversation an append target names, refusing one never offered.
   *
   * The real Host resolves a target by looking it up in a catalogue it just
   * built; this does the same against the submissions it holds, so a panel that
   * sent an id nobody offered is refused here rather than quietly served.
   */
  function appendTarget(request: BrowserContextSubmitRequestV1): string | undefined {
    if (!request.targetId || request.targetId === "chat:new") return undefined
    const offered = deliveryTargets().find((target) => target.id === request.targetId)
    if (!offered) throw new Error(`unknown_target: ${request.targetId}`)
    return request.targetId.slice("session:".length)
  }

  function summaryOf(row: RecordedSubmission): BrowserContextSubmissionSummaryV1 {
    return {
      submissionId: row.submissionId,
      sessionId: row.sessionId,
      title: row.title,
      sourceHost: row.sourceHost,
      captureMode: row.captureMode as BrowserContextSubmissionSummaryV1["captureMode"],
      status: row.status,
      submittedAt: row.submittedAt,
      updatedAt: row.updatedAt,
      deepLink: `cognia://session/${row.sessionId}`,
    }
  }

  function summaries(): BrowserContextSubmissionSummaryV1[] {
    return [...submissions].reverse().map(summaryOf)
  }

  /**
   * The catalogue, built the way the real Host builds it.
   *
   * From the submissions this mock has accepted, not from a fixture: the panel
   * treats an id it was not offered as a refusal, so a hand-written list would
   * pass while the real pairing of "what the Host offers" and "what the panel
   * may send" went untested.
   */
  function deliveryTargets(): NonNullable<BrowserCompanionCapabilityV1["deliveryTargets"]> {
    return [
      { id: "chat:new", kind: "chat", label: "New task", isDefault: true },
      ...[...submissions].reverse().map((row) => ({
        id: `session:${row.sessionId}`,
        kind: "session" as const,
        label: row.title,
        isDefault: false,
        workspaceId: row.workspaceId,
        detail: row.sourceHost,
      })),
    ]
  }

  function consumeChallenge(challengeId: string, nonce: string): boolean {
    const challenge = challenges.get(challengeId)
    if (!challenge || challenge.nonce !== nonce || challenge.expiresAt <= Date.now()) return false
    challenges.delete(challengeId)
    return true
  }

  function verifyProof(
    publicKeyPem: string,
    proof: string,
    expected: { nonce: string; method: string; path: string }
  ): { ok: true } | { ok: false; status: number; code: string; message: string } {
    const reject = (code: string, message: string) => ({
      ok: false as const,
      status: 401,
      code,
      message,
    })
    const segments = proof.split(".")
    if (segments.length !== 3) return reject("invalid_device_proof", "the proof is malformed")
    let claims: Record<string, unknown>
    try {
      claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"))
    } catch {
      return reject("invalid_device_proof", "the proof payload is not JSON")
    }
    let key
    try {
      key = createPublicKey(publicKeyPem)
    } catch {
      return { ok: false, status: 400, code: "invalid_device_key", message: "bad public key" }
    }
    // ES256 signatures on the wire are raw r‖s, not DER. Verifying with the
    // default encoding silently fails every time and looks like a bad key.
    const valid = verifySignature(
      "sha256",
      Buffer.from(`${segments[0]}.${segments[1]}`, "utf8"),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(segments[2], "base64url")
    )
    if (!valid) return reject("invalid_device_proof", "the proof signature does not verify")

    const nowSeconds = Math.floor(Date.now() / 1_000)
    const iat = Number(claims.iat)
    const fresh =
      Number.isFinite(iat) &&
      iat >= nowSeconds - PROOF_CLOCK_SKEW_SECS &&
      iat <= nowSeconds + PROOF_CLOCK_SKEW_SECS
    if (!fresh) return reject("device_proof_mismatch", "the proof is not fresh")
    if (
      claims.nonce !== expected.nonce ||
      claims.htm !== expected.method ||
      claims.htu !== expected.path ||
      typeof claims.jti !== "string" ||
      claims.jti.length === 0
    ) {
      return reject("device_proof_mismatch", "the proof does not match this request")
    }
    // Replay protection, as `consume_device_proof` does. Without it a captured
    // proof is a reusable credential for its whole 60s life.
    if (seenProofIds.has(claims.jti)) {
      return { ok: false, status: 409, code: "device_proof_replay", message: "proof reused" }
    }
    seenProofIds.add(claims.jti)
    return { ok: true }
  }

  return {
    baseUrl,
    issueEnrollment({ expiresInMs = 300_000 } = {}) {
      const enrollment = `${randomUUID()}.${randomUUID()}`
      const expiresAt = Date.now() + expiresInMs
      enrollments.set(enrollment, { expiresAt, spent: false })
      return encodeBrowserEnrollmentPayload({ baseUrl, tenantId, enrollment, expiresAt })
    },
    requests: () => [...requests],
    submissions: () => [...submissions],
    sessionIds: () => [...new Set(submissions.map((row) => row.sessionId))],
    devices: () =>
      [...devices.values()].map(({ deviceId, extensionOrigin, capabilities }) => ({
        deviceId,
        extensionOrigin,
        capabilities,
      })),
    setStatus(submissionId, status) {
      const row = submissions.find((item) => item.submissionId === submissionId)
      if (!row) throw new Error(`no submission ${submissionId}`)
      row.status = status
      row.updatedAt = Date.now()
    },
    revokeDevices() {
      for (const device of devices.values()) device.revoked = true
    },
    setUnreachable(next) {
      unreachable = next
    },
    servePage(name, html) {
      pages.set(`/page/${name}`, html)
      return `${baseUrl}/page/${name}`
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name]
  return typeof value === "string" ? value : null
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * A token the client can read a `jti` out of, and nothing more.
 *
 * Deliberately unsigned: the extension never verifies it — it has no key for
 * the Host's signer — and pretending otherwise would put a second, meaningless
 * crypto implementation in the test harness.
 */
function fakeJwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
  return `${part({ alg: "none", typ: "JWT" })}.${part(claims)}.${part("mock")}`
}

function readJwtId(token: string): string | null {
  const segments = token.split(".")
  if (segments.length !== 3) return null
  try {
    const claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"))
    return typeof claims.jti === "string" ? claims.jti : null
  } catch {
    return null
  }
}

/** Mirrors `extension_origin.rs::normalize_browser_plane_origin`. */
function normalizeExtensionOrigin(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== "chrome-extension:") return null
  // `chrome-extension:` is not a special scheme, so `pathname` is "" and not
  // "/" — a `pathname !== "/"` guard rejects every valid extension origin.
  if (url.pathname !== "" && url.pathname !== "/") return null
  if (url.search !== "" || url.hash !== "" || url.port !== "") return null
  if (!/^[a-p]{32}$/.test(url.hostname)) return null
  return `chrome-extension://${url.hostname}`
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname
  } catch {
    return ""
  }
}

/** Exported for the harness's own suite. */
export const __testables = { normalizeExtensionOrigin, readJwtId, hostOf, createHash }
