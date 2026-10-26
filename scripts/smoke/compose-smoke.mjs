#!/usr/bin/env node
/**
 * End-to-end smoke for the compose suite (ADR-0059 P0.4 / W6 / F2).
 *
 * Runs identically on Windows (PowerShell / Git Bash) and CI — Node 22 globals
 * (`fetch`, `WebSocket`), no bash/PowerShell duplication. Assumes the compose
 * stack is already up (`docker compose up -d --wait`); this script only drives
 * and asserts. Exit 0 on success, 1 otherwise.
 *
 * Tiers (each a superset of the prior):
 *   --tier services  (default)  signaling + share only. No secrets beyond
 *                               SHARE_UPLOAD_SECRET.
 *   --tier server               + cognia-server (pair → chat → agent → webhook).
 *                               Added by ADR-0059 W6 (D6).
 *   --tier tls                  + Caddy front door. Added by F2 (D7).
 *   --tier im                   + a configured OneBot reverse-WS event → brain
 *   --tier cloud               a multi-tenant gateway + collab-server: the
 *                              account plane (claim, invite, accept). Needs
 *                              COGNIA_CLOUD_SERVER_URL (default
 *                              https://localhost:27894), COLLAB_URL (default
 *                              http://localhost:8080) and either the OIDC
 *                              fixture (COGNIA_SMOKE_OIDC_E2E_TOKEN_URL) or two
 *                              pre-minted tokens (COGNIA_SMOKE_OWNER_TOKEN,
 *                              COGNIA_SMOKE_MEMBER_TOKEN). Bootstrap needs
 *                              COGNIA_SMOKE_BOOTSTRAP_CREDENTIAL once.
 *   --tier persons            two OIDC persons of one org on one multi-tenant
 *                              Host (plan §9a, P6f): partition isolation,
 *                              HostState sessions without a Host admin lease,
 *                              the P5 dormancy codes, tool-less member chat,
 *                              sandboxed member agents (with gVisor), the
 *                              operator's persons list and purge. Needs the org and both people
 *                              seeded with cognia-collab-bootstrap (Logto org
 *                              id included) and the OIDC fixture. Env: see
 *                              PERSONS_* below.
 *                               AI turn → outbound action. Added by F6/H8.
 *
 * Env knobs:
 *   SIGNALING_URL   default http://localhost:7892
 *   SHARE_URL       default http://localhost:8787
 *   SHARE_UPLOAD_SECRET   required for the share write/delete roundtrip
 *   COGNIA_SERVER_URL     default https://localhost:27890
 *   COMPOSE_FILE_PATH     compose file for in-container exec (resolved
 *                         against the repo root, so cwd doesn't matter)
 *   COGNIA_SMOKE_EXEC     override the in-container exec prefix entirely —
 *                         lets tier 2 run on k8s, e.g.
 *                         COGNIA_SMOKE_EXEC="kubectl -n cognia-kind exec -i cognia-server-0 --"
 *   COGNIA_SMOKE_ONEBOT_ADAPTER_ID   enabled reverse-WS adapter already seeded
 *   COGNIA_SMOKE_ONEBOT_BEARER       its configured onebotBearer credential
 */

import process from "node:process"
import { createHash, randomBytes, randomUUID, webcrypto } from "node:crypto"
import http from "node:http"
import https from "node:https"
import { readFileSync } from "node:fs"
import { execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

const execFile = promisify(execFileCb)

if (typeof globalThis.WebSocket !== "function") {
  console.error("[smoke] FAIL: globalThis.WebSocket is undefined — needs Node 22+")
  process.exit(1)
}

// ---------------------------------------------------------------------------
// CLI + helpers
// ---------------------------------------------------------------------------

const TIERS = ["services", "server", "tls", "im", "cloud", "persons"]
function parseTier() {
  const i = process.argv.indexOf("--tier")
  const t = i >= 0 ? process.argv[i + 1] : "services"
  if (!TIERS.includes(t)) fatal(`unknown --tier ${t} (want one of: ${TIERS.join(", ")})`)
  return t
}

const SIGNALING_URL = process.env.SIGNALING_URL ?? "http://localhost:7892"
const SHARE_URL = process.env.SHARE_URL ?? "http://localhost:8787"

let failures = 0
function log(...a) {
  console.log("[smoke]", ...a)
}
function skip(msg) {
  console.log("[smoke] SKIP:", msg)
}
function fatal(msg) {
  console.error("[smoke] FAIL:", msg)
  process.exit(1)
}
function check(cond, msg) {
  if (cond) {
    log("  ok:", msg)
  } else {
    console.error("[smoke]  FAIL:", msg)
    failures++
  }
}

/** Poll an HTTP endpoint until it responds ok or the deadline passes. */
async function waitForHealthz(base, { tries = 30, intervalMs = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/healthz`)
      if (res.ok) return await res.json()
    } catch {
      // not up yet
    }
    await delay(intervalMs)
  }
  fatal(`${base}/healthz did not become healthy in ${tries * intervalMs}ms`)
}

// ---------------------------------------------------------------------------
// Tier 1 — services
// ---------------------------------------------------------------------------

async function shareRoundtrip() {
  const secret = process.env.SHARE_UPLOAD_SECRET
  if (!secret) {
    skip("SHARE_UPLOAD_SECRET unset — share write/delete roundtrip not exercised")
    return
  }
  const envelope = {
    v: 1,
    alg: "AES-GCM",
    iv: "AAAAAAAAAAAAAAAA",
    ciphertext: "Y2lwaGVydGV4dA==",
    checksum: "deadbeef",
  }
  // Create
  const created = await fetch(`${SHARE_URL}/v1/share`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ envelope, ttlSeconds: 300 }),
  })
  check(created.status === 201, `POST /v1/share → 201 (got ${created.status})`)
  const { code, ownerToken } = await created.json()
  check(typeof code === "string" && code.length === 12, `share code is 12 chars (got ${code})`)

  // Read (public)
  const read = await fetch(`${SHARE_URL}/v1/share/${code}`)
  check(read.status === 200, `GET /v1/share/${code} → 200 (got ${read.status})`)
  const readBody = await read.json()
  check(
    readBody?.envelope?.ciphertext === envelope.ciphertext,
    "read envelope round-trips the ciphertext"
  )

  // Delete (owner)
  const del = await fetch(`${SHARE_URL}/v1/share/${code}`, {
    method: "DELETE",
    headers: { "X-Owner-Token": ownerToken },
  })
  check(del.status === 200 || del.status === 204, `DELETE → 2xx (got ${del.status})`)
  const gone = await fetch(`${SHARE_URL}/v1/share/${code}`)
  check(gone.status === 404, `GET after delete → 404 (got ${gone.status})`)
}

function signalingWs(label, url = `${SIGNALING_URL.replace(/^http/, "ws")}/signaling`) {
  const ws = new WebSocket(url)
  const inbox = []
  const waiters = []
  ws.addEventListener("message", (e) => {
    inbox.push(JSON.parse(e.data.toString()))
    while (waiters.length && inbox.length) waiters.shift()(inbox.shift())
  })
  return {
    label,
    open: () =>
      new Promise((res, rej) => {
        ws.addEventListener("open", () => res(), { once: true })
        ws.addEventListener("error", () => rej(new Error(`ws[${label}] error`)), { once: true })
      }),
    send: (f) => ws.send(JSON.stringify(f)),
    next: (ms = 2000) =>
      inbox.length
        ? Promise.resolve(inbox.shift())
        : Promise.race([new Promise((r) => waiters.push(r)), delay(ms).then(() => null)]),
    close: () => ws.close(),
  }
}

function signalingFields(fields) {
  const parts = []
  for (const value of fields) {
    const field = Buffer.from(String(value))
    const length = Buffer.alloc(4)
    length.writeUInt32BE(field.byteLength)
    parts.push(length, field)
  }
  return Buffer.concat(parts)
}

async function signalingIdentity() {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])
  return {
    privateKey: pair.privateKey,
    publicKey: Buffer.from(await webcrypto.subtle.exportKey("raw", pair.publicKey)).toString(
      "base64url"
    ),
  }
}

async function signalingRoom() {
  const [desktop, mobile] = await Promise.all([signalingIdentity(), signalingIdentity()])
  const roomNonce = randomBytes(16).toString("base64url")
  const notAfter = Date.now() + 60_000
  const digest = await webcrypto.subtle.digest(
    "SHA-256",
    signalingFields([2, roomNonce, desktop.publicKey, mobile.publicKey, notAfter])
  )
  const roomId = Buffer.from(digest).toString("base64url")
  return {
    descriptor: {
      v: 2,
      roomId,
      roomNonce,
      desktopSigningKey: desktop.publicKey,
      mobileSigningKey: mobile.publicKey,
      notAfter,
    },
    desktop,
    mobile,
  }
}

async function signalingSubscribe(room, role, challenge) {
  const ecdh = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])
  const proof = {
    v: 2,
    roomId: room.descriptor.roomId,
    role,
    sessionId: randomBytes(16).toString("base64url"),
    epoch: randomBytes(16).toString("base64url"),
    issuedAt: Date.now(),
    challenge,
    ecdhPublicKey: Buffer.from(await webcrypto.subtle.exportKey("raw", ecdh.publicKey)).toString(
      "base64url"
    ),
  }
  const signature = await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    room[role].privateKey,
    signalingFields([
      proof.v,
      proof.roomId,
      proof.role,
      proof.sessionId,
      proof.epoch,
      proof.issuedAt,
      proof.challenge,
      proof.ecdhPublicKey,
    ])
  )
  return {
    kind: "subscribe",
    descriptor: room.descriptor,
    proof: { ...proof, signature: Buffer.from(signature).toString("base64url") },
  }
}

async function signalingRelay() {
  const a = signalingWs("A")
  const b = signalingWs("B")
  // Attach both listeners before either connection can finish opening.
  await Promise.all([a.open(), b.open()])
  const [aChallenge, bChallenge, room] = await Promise.all([a.next(), b.next(), signalingRoom()])
  check(aChallenge?.kind === "challenge", "A received challenge")
  check(bChallenge?.kind === "challenge", "B received challenge")
  a.send(await signalingSubscribe(room, "desktop", aChallenge.challenge))
  const aSubbed = await a.next()
  check(aSubbed?.kind === "subscribed", "A subscribed")
  b.send(await signalingSubscribe(room, "mobile", bChallenge.challenge))
  await b.next()
  const payload = JSON.stringify({ ciphertext: "opaque" })
  b.send({ kind: "relay", rendezvousId: room.descriptor.roomId, payload })
  // A receives peerJoined then relay (order: drain until relay).
  let relayed = null
  for (let i = 0; i < 4 && !relayed; i++) {
    const f = await a.next()
    if (f?.kind === "relay") relayed = f
  }
  check(relayed?.payload === payload, "A received B's relayed payload")
  a.close()
  b.close()
}

async function metricsShape() {
  for (const [base, fragment] of [
    [SIGNALING_URL, "signaling_uptime_seconds"],
    [SHARE_URL, "share_"],
  ]) {
    const res = await fetch(`${base}/metrics`)
    check(res.ok, `${base}/metrics → 200`)
    const text = await res.text()
    check(text.includes(fragment), `${base}/metrics contains "${fragment}"`)
  }
}

async function tierServices() {
  log("tier: services")
  const sh = await waitForHealthz(SIGNALING_URL)
  check(sh?.ok === true, "signaling /healthz ok")
  const shh = await waitForHealthz(SHARE_URL)
  check(shh?.ok === true, "share /healthz ok")
  await shareRoundtrip()
  await signalingRelay()
  await metricsShape()
}

// ---------------------------------------------------------------------------
// Tier 2 — cognia-server (ADR-0059 W6 / D6)
//
// The Phase-1 exit gate: a client pairs against the container and the brain
// executes the data plane server-side. The service-only external-agent arms
// are driven from INSIDE the container (`docker compose exec` + loopback
// curl) because service tokens are loopback-gated by design.
// ---------------------------------------------------------------------------

const SERVER_URL = process.env.COGNIA_SERVER_URL ?? "https://localhost:27890"
// Resolve the compose file against the repo root (this file lives at
// scripts/smoke/), so tiers 2/3 work from any cwd.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const COMPOSE_FILE = path.resolve(
  REPO_ROOT,
  process.env.COMPOSE_FILE_PATH ?? "deploy/compose/docker-compose.yml"
)
const COMMAND_MANIFEST = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "protocol/companion-commands.json"), "utf8")
)
const COMMANDS = new Map(COMMAND_MANIFEST.commands.map((command) => [command.name, command]))
// The Headless catalog cognia-server embeds (cognia-headless-contract
// include_bytes!s this file), so healthz must report exactly its version,
// hash and size when the image was built from this checkout.
const HEADLESS_CATALOG = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "crates/cognia-cli/assets/host-command-catalog.json"), "utf8")
)

/**
 * Run a command INSIDE the cognia-server container → stdout.
 * Default transport is `docker compose exec`; COGNIA_SMOKE_EXEC swaps the
 * whole prefix so the same tier runs on k8s (kubectl exec) or anything else
 * that can reach the container's loopback.
 */
async function composeExec(argv, { timeoutMs = 60_000 } = {}) {
  const prefix = process.env.COGNIA_SMOKE_EXEC
    ? process.env.COGNIA_SMOKE_EXEC.split(/\s+/).filter(Boolean)
    : [
        "docker",
        "compose",
        "-f",
        COMPOSE_FILE,
        "--profile",
        "server",
        "exec",
        "-T",
        "cognia-server",
      ]
  const { stdout } = await execFile(prefix[0], [...prefix.slice(1), ...argv], {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout
}

/**
 * Canonical DPoP RPC against the published port (`auth.baseUrl` when the
 * device belongs to another Host, as in the persons tier).
 */
async function rpc(name, args, auth) {
  const path = `/api/_rpc/${name}`
  const descriptor = COMMANDS.get(name)
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    "Content-Type": "application/json",
  }
  if (descriptor?.idempotency === "required") headers["Idempotency-Key"] = randomUUID()
  const send = async () =>
    fetch(`${auth.baseUrl ?? SERVER_URL}${path}`, {
      method: "POST",
      headers: {
        ...headers,
        DPoP: await deviceProof(auth.privateKey, auth.accessJti, "POST", path),
      },
      body: JSON.stringify(args ?? {}),
    })
  let res = await send()
  let envelope = await res.json().catch(() => null)
  // The Host meters each device's remote calls; wait out a 429 as a client
  // would, with the same idempotency key and a fresh proof per attempt.
  for (let attempt = 0; res.status === 429 && attempt < 5; attempt++) {
    const seconds = Number(
      envelope?.details?.retryAfterSeconds ?? res.headers.get("retry-after") ?? 1
    )
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, seconds) * 1000))
    res = await send()
    envelope = await res.json().catch(() => null)
  }
  // The device plane answers `{requestId, result}`; errors are problem
  // documents without it. Unwrap the way the real client does
  // (lib/tauri/transport-companion.ts), so callers read the result itself.
  const body =
    res.ok && envelope !== null && typeof envelope === "object" && Object.hasOwn(envelope, "result")
      ? envelope.result
      : envelope
  return { status: res.status, body, envelope }
}

/** Loopback RPC from inside the container (service scope). */
async function containerRpc(name, args, token) {
  const response = await containerRpcResponse(name, args, token)
  return response.body
}

async function containerRpcResponse(name, args, token) {
  const idempotency =
    COMMANDS.get(name)?.idempotency === "required" ? ["-H", `Idempotency-Key: ${randomUUID()}`] : []
  const out = await composeExec([
    "curl",
    "-sk",
    "-X",
    "POST",
    `https://127.0.0.1:27890/internal/_rpc/${name}`,
    "-H",
    `Authorization: Bearer ${token}`,
    "-H",
    "Content-Type: application/json",
    ...idempotency,
    "-d",
    JSON.stringify(args ?? {}),
    "-w",
    "\n%{http_code}",
  ])
  const lines = out.trimEnd().split("\n")
  const status = Number(lines.pop())
  const rawBody = lines.join("\n")
  try {
    return { status, body: JSON.parse(rawBody) }
  } catch {
    return { status, body: rawBody.trim() }
  }
}

async function headlessContractGuards(health) {
  const expected = HEADLESS_CATALOG
  check(
    health?.headlessContract?.schemaVersion === expected.schemaVersion,
    `healthz reports Headless contract v${expected.schemaVersion} (got v${health?.headlessContract?.schemaVersion})`
  )
  check(
    health?.headlessContract?.catalogHash === expected.catalogHash,
    `healthz reports this checkout's Headless catalog hash (got ${health?.headlessContract?.catalogHash})`
  )
  check(
    health?.headlessContract?.commandCount === expected.commands.length,
    `healthz reports all ${expected.commands.length} Headless commands (got ${health?.headlessContract?.commandCount})`
  )
  const token = (await composeExec(["cognia-server", "issue-service-token"])).trim()
  const invalid = await containerRpcResponse("mcp_oauth_status", {}, token)
  check(invalid.status === 422, `invalid Headless input → 422 (got ${invalid.status})`)
  check(
    invalid.body?.code === "contract_input_violation",
    "invalid Headless input uses the strict contract envelope"
  )
  check(
    !JSON.stringify(invalid.body?.details ?? {}).includes("serverName"),
    "contract diagnostics do not echo rejected values"
  )
}

async function waitForServerHealthz() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${SERVER_URL}/healthz`)
      if (res.ok) return await res.json()
    } catch {
      // not up yet
    }
    await delay(2000)
  }
  fatal(`${SERVER_URL}/healthz did not become healthy in 120s`)
}

/** Readiness includes bootstrap completion and required runtimes, unlike bridge hello. */
export async function waitForBrainReady({ tries = 60, intervalMs = 2000 } = {}) {
  let lastChecks
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${SERVER_URL}/readyz`)
      const body = await res.json()
      if (res.ok && body?.status === "ready") return body
      lastChecks = body?.checks
    } catch {
      // The HTTP server or its brain may still be starting.
    }
    await delay(intervalMs)
  }
  throw new Error(
    `host required runtimes never became ready (/readyz): ${JSON.stringify(lastChecks ?? {})}`
  )
}

async function pairDevice() {
  // The smoke registers over the published port, not through a relay, so it
  // accepts a relay-less invitation: without --direct `pair` refuses one
  // (ADR-0224 A2), and a CI runner need not reach the relay.
  const out = await composeExec([
    "cognia-server",
    "pair",
    "--device-name",
    "smoke",
    "--direct",
    "--no-qr",
  ])
  // cgnp4 when the runner can reach the relay, cgnp3 when it cannot; both
  // carry the direct fields registered against below.
  const match = out.match(/cgnp[34]\|([A-Za-z0-9_-]+)/)
  check(!!match, "pair subcommand printed a cgnp3 or cgnp4 payload")
  if (!match) return null
  const payload = JSON.parse(Buffer.from(match[1], "base64url").toString())
  check(payload.mode === "owner-invitation", "pair payload uses Owner invitation mode")
  const config = await fetch(`${SERVER_URL}/api/auth/config`).then((response) => response.json())
  check(config.hostId === payload.host, "auth config Host matches the pair payload")
  const authKeys = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )
  const signalingKeys = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )
  const deviceId = randomUUID()
  const publicKeyPem = spkiPem(await webcrypto.subtle.exportKey("spki", authKeys.publicKey))
  const signalingPublicKey = Buffer.from(
    await webcrypto.subtle.exportKey("raw", signalingKeys.publicKey)
  ).toString("base64url")
  const challenge = await requestDeviceChallenge(payload.tenant)
  const res = await fetch(`${SERVER_URL}/api/auth/device/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tenantId: payload.tenant,
      invitation: payload.invitation,
      challengeId: challenge.challengeId,
      challengeNonce: challenge.nonce,
      deviceId,
      displayName: "compose-smoke",
      publicKeyPem,
      signalingPublicKey,
      proof: await deviceProof(
        authKeys.privateKey,
        challenge.nonce,
        "POST",
        "/api/auth/device/register"
      ),
    }),
  })
  check(res.status === 200, `POST /api/auth/device/register → 200 (got ${res.status})`)
  const body = await res.json()
  check(
    body.signaling?.roomDescriptor?.mobileSigningKey === signalingPublicKey,
    "registration returned the bound signaling descriptor"
  )
  const tokenChallenge = await requestDeviceChallenge(payload.tenant)
  const tokenResponse = await fetch(`${SERVER_URL}/api/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tenantId: payload.tenant,
      deviceId,
      challengeId: tokenChallenge.challengeId,
      challengeNonce: tokenChallenge.nonce,
      proof: await deviceProof(
        authKeys.privateKey,
        tokenChallenge.nonce,
        "POST",
        "/api/auth/token"
      ),
    }),
  })
  check(tokenResponse.status === 200, `POST /api/auth/token → 200 (got ${tokenResponse.status})`)
  const token = await tokenResponse.json()
  const claims = JSON.parse(Buffer.from(token.accessToken.split(".")[1], "base64url").toString())
  return {
    deviceId,
    privateKey: authKeys.privateKey,
    accessToken: token.accessToken,
    accessJti: claims.jti,
    signalingRoom: {
      descriptor: body.signaling.roomDescriptor,
      mobile: signalingKeys,
    },
  }
}

async function requestDeviceChallenge(tenantId) {
  const response = await fetch(`${SERVER_URL}/api/auth/device/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId }),
  })
  return response.json()
}

function spkiPem(buffer) {
  const base64 = Buffer.from(buffer).toString("base64")
  return `-----BEGIN PUBLIC KEY-----\n${base64.match(/.{1,64}/g).join("\n")}\n-----END PUBLIC KEY-----\n`
}

async function deviceProof(privateKey, nonce, method, path) {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "dpop+jwt" })).toString(
    "base64url"
  )
  const payload = Buffer.from(
    JSON.stringify({ nonce, htm: method, htu: path, iat: now, exp: now + 60, jti: randomUUID() })
  ).toString("base64url")
  const signingInput = `${header}.${payload}`
  const signature = await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    Buffer.from(signingInput)
  )
  return `${signingInput}.${Buffer.from(signature).toString("base64url")}`
}

async function dataPlaneRoundtrip(jwt) {
  const pull = await rpc("sync_pull", { table: "sessions", since: 0 }, jwt)
  check(pull.status === 200, `sync_pull → 200 (got ${pull.status}: ${JSON.stringify(pull.body)})`)
  check(Array.isArray(pull.body?.rows), "sync_pull delta has rows[] (answered by the brain)")

  // message_send only appends to a session the host already has, so create
  // one first through HostState, as a paired browser does for a new chat.
  const sessionId = await createHostSession(jwt)
  const marker = `smoke-${Date.now()}`
  const send = await rpc("message_send", { session_id: sessionId, content: marker }, jwt)
  check(
    send.status === 200,
    `message_send → 200 (got ${send.status}: ${JSON.stringify(send.body)})`
  )
  const read = await rpc("message_get_by_session", { session_id: sessionId }, jwt)
  check(
    // One page (ADR-0175 B3): `items`, each a MessageRow (`content`) or, from
    // the brain's bridge, a StoredMessage whose text lives in `parts`.
    read.body?.items?.some(
      (row) =>
        row.content === marker ||
        row.parts?.some((part) => part?.type === "text" && part.text === marker)
    ),
    `message_send round-trips through the brain's Dexie (got ${read.status}: ${JSON.stringify(read.body).slice(0, 300)})`
  )
}

/**
 * Mint the interactive-approval lease an `approval: interactive` command
 * needs, the way lib/tauri/admin-lease.ts does. When the host asks for consent
 * (REMOTE_CONSENT_REQUIRED, with a short code), answer it from the console
 * side — the loopback service principal — and ask again.
 */
async function issueAdminLease(operations, jwt) {
  let lease = await rpc("host_admin_lease_issue", { operations, ttlSeconds: 300 }, jwt)
  const refusal = JSON.stringify(lease.body ?? "")
  if (lease.status !== 200 && refusal.includes("REMOTE_CONSENT_REQUIRED")) {
    const code = /\(code\s+([A-Za-z0-9]+)\)/.exec(refusal)?.[1]
    check(Boolean(code), "the consent refusal carries an approval code")
    const token = (await composeExec(["cognia-server", "issue-service-token"])).trim()
    const answered = await containerRpcResponse(
      "host_consent_respond",
      { requestId: code, approve: true },
      token
    )
    check(answered.status === 200, `host_consent_respond approved ${code} (got ${answered.status})`)
    lease = await rpc("host_admin_lease_issue", { operations, ttlSeconds: 300 }, jwt)
  }
  check(
    lease.status === 200 && typeof lease.body?.token === "string",
    `host_admin_lease_issue → lease for ${operations.join(", ")} (got ${lease.status})`
  )
  return lease.body?.token
}

/** Create a session on the host via a HostState `session.create` action. */
async function createHostSession(jwt) {
  const manifest = await rpc("host_feature_manifest", {}, jwt)
  const scope = manifest.body?.hostStateScope
  check(
    typeof scope?.accountId === "string" && typeof scope?.runtimeTargetId === "string",
    "host_feature_manifest reports the HostState scope"
  )
  const status = await rpc("host_state_status", scope, jwt)
  check(
    status.status === 200 && typeof status.body?.hostId === "string",
    `host_state_status → 200 (got ${status.status})`
  )
  const adminLease = await issueAdminLease(["host_state_submit"], jwt)
  const sessionId = `smoke-session-${randomUUID()}`
  const actionId = randomUUID()
  const submit = await rpc(
    "host_state_submit",
    {
      ...scope,
      adminLease,
      actions: [
        {
          // sessionStateChannel() in packages/agent-config-types/src/host-state.ts
          channel: `cognia://target/${encodeURIComponent(scope.runtimeTargetId)}/sessions/${encodeURIComponent(sessionId)}`,
          ...scope,
          hostId: status.body.hostId,
          hostGeneration: status.body.hostGeneration,
          sessionId,
          clientId: "compose-smoke",
          clientSeq: 1,
          actionId,
          createdAt: Date.now(),
          action: { kind: "session.create", title: "Compose smoke" },
        },
      ],
    },
    jwt
  )
  const receipt = submit.body?.results?.[0]
  check(
    submit.status === 200 && receipt?.actionId === actionId && receipt?.outcome === "applied",
    `host_state_submit session.create applied (got ${submit.status}: ${JSON.stringify(submit.body)})`
  )
  return sessionId
}

async function chatTurn(jwt) {
  if (!process.env.ANTHROPIC_API_KEY) {
    skip("ANTHROPIC_API_KEY unset — sidecar chat turn not exercised")
    return
  }
  // Push the key into the headless ApiKeyState, then send. The sidecar is
  // spawned by cognia-server on first send (R7/R8).
  const setKey = await rpc("claude_set_api_key", { key: process.env.ANTHROPIC_API_KEY }, jwt)
  check(setKey.status === 200, "claude_set_api_key accepted")
  const sendRes = await rpc(
    "claude_send",
    { session_id: "smoke-chat", prompt: "Reply with the single word: pong" },
    jwt
  )
  check(sendRes.status === 200, `claude_send → 200 (got ${sendRes.status})`)

  const ticketPath = "/api/auth/socket-ticket"
  const ticketResponse = await fetch(`${SERVER_URL}${ticketPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt.accessToken}`,
      DPoP: await deviceProof(jwt.privateKey, jwt.accessJti, "POST", ticketPath),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: "events" }),
  })
  const { ticket } = await ticketResponse.json()
  check(ticketResponse.ok && typeof ticket === "string", "chat event socket ticket issued")

  // Watch canonical /ws/events with the single-use path-bound ticket.
  const sawEvent = await new Promise((resolve) => {
    const ws = new WebSocket(
      `${SERVER_URL.replace(/^http/, "ws")}/ws/events?ticket=${encodeURIComponent(ticket)}`
    )
    const timer = setTimeout(() => {
      ws.close()
      resolve(false)
    }, 90_000)
    ws.addEventListener("message", (e) => {
      try {
        const frame = JSON.parse(e.data.toString())
        if (frame.type === "claude://message" && frame.payload?.sessionId === "smoke-chat") {
          clearTimeout(timer)
          ws.close()
          resolve(true)
        }
      } catch {
        // ignore
      }
    })
    ws.addEventListener("error", () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
  check(sawEvent, "sidecar chat turn produced claude://message frames for the session")
}

async function externalAgentTurn() {
  // Service tokens are loopback-only → everything runs inside the container.
  const token = (await composeExec(["cognia-server", "issue-service-token"])).trim()
  check(token.split(".").length === 3, "issue-service-token printed a JWT")

  // With the T2 overlay (sandbox pool on) a headless host places every
  // external agent in a runner container (ADR-0224 A8), and the stub ships
  // only in the server image, so its lifecycle cannot run there. The policy
  // denial below is placement-independent and still runs.
  // `sandbox-pool` in host_capabilities is coarse (every headless host lists
  // it); whether the pool is ON is answered here, `sandbox_pool_disabled`
  // when it is off, as compose-runtime-environment.mjs reads it.
  const driver = await containerRpcResponse("environment_driver_status", {}, token)
  if (driver.status === 200 && typeof driver.body?.driver === "string") {
    skip("sandbox pool on (T2): external agents run in the runner image, which has no smoke stub")
  } else {
    await stubAgentLifecycle(token)
  }
  await spawnPolicyDenial(token)
}

async function stubAgentLifecycle(token) {
  const spawned = await containerRpc(
    "spawn_external_agent",
    {
      config: {
        id: "smoke-agent-1",
        command: "node",
        args: ["/opt/cognia/smoke/stub-acp-agent.mjs"],
      },
    },
    token
  )
  check(
    spawned === "smoke-agent-1",
    `spawn_external_agent admitted the stub (got ${JSON.stringify(spawned)})`
  )

  const status = await containerRpc(
    "get_external_agent_status",
    { agent_id: "smoke-agent-1" },
    token
  )
  check(status === "Running", `stub agent is Running (got ${JSON.stringify(status)})`)

  const sent = await containerRpc(
    "send_to_external_agent",
    { agent_id: "smoke-agent-1", message: "ping" },
    token
  )
  check(sent === null, "send_to_external_agent wrote to the stub's stdin")

  const killed = await containerRpc("kill_external_agent", { agent_id: "smoke-agent-1" }, token)
  check(killed === null, "kill_external_agent stopped the stub")
}

async function spawnPolicyDenial(token) {
  // Policy denial is audited + rejected: an arbitrary binary must not spawn.
  const denied = await containerRpc(
    "spawn_external_agent",
    { config: { id: "evil", command: "bash", args: ["-c", "id"] } },
    token
  )
  check(
    denied?.code === "remote_control_forbidden" || /denied by policy/.test(denied?.message ?? ""),
    `SpawnPolicy denies arbitrary binaries (got ${JSON.stringify(denied)})`
  )
}

async function webhookIngressShape() {
  // Webhook ingress shares the per-source-IP pre-auth bucket with pairing
  // (middleware::pre_auth_rate_limit), which this run has just drained from
  // the same address. Wait out the advertised interval instead of assuming a
  // fresh bucket.
  let res
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(`${SERVER_URL}/connectors/webhook/telegram/ghost`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    if (res.status !== 429) break
    const problem = await res.json().catch(() => null)
    const seconds = Number(
      problem?.details?.retryAfterSeconds ?? res.headers.get("retry-after") ?? 3
    )
    await delay(Math.max(1, seconds) * 1000)
  }
  check(res.status === 404, `unregistered webhook adapter → 404 (got ${res.status})`)
  const body = await res.json().catch(() => null)
  check(body?.error === "adapter not registered", "webhook rejection shape is deterministic")
}

function encodeWebSocketFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const mask = randomBytes(4)
  let header
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | body.length])
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(body.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(body.length), 2)
  }
  const masked = Buffer.from(body)
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % mask.length]
  return Buffer.concat([header, mask, masked])
}

/** Minimal authenticated WebSocket client for the OneBot smoke stub. */
function openOneBotStub(adapterId, bearer) {
  const url = new URL(`/connectors/ws/onebot/${encodeURIComponent(adapterId)}`, SERVER_URL)
  const client = url.protocol === "https:" ? https : http
  const key = randomBytes(16).toString("base64")
  let socket
  let buffer = Buffer.alloc(0)
  const inbox = []
  const waiters = []

  const push = (message) => {
    if (waiters.length) waiters.shift()(message)
    else inbox.push(message)
  }
  const consume = () => {
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f
      const masked = (buffer[1] & 0x80) !== 0
      let length = buffer[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        const wideLength = buffer.readBigUInt64BE(2)
        if (wideLength > BigInt(Number.MAX_SAFE_INTEGER)) fatal("OneBot frame is too large")
        length = Number(wideLength)
        offset = 10
      }
      const maskOffset = masked ? 4 : 0
      if (buffer.length < offset + maskOffset + length) return
      const mask = masked ? buffer.subarray(offset, offset + 4) : null
      offset += maskOffset
      const payload = Buffer.from(buffer.subarray(offset, offset + length))
      buffer = buffer.subarray(offset + length)
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
      if (opcode === 0x1) {
        try {
          push(JSON.parse(payload.toString("utf8")))
        } catch {
          // Ignore non-JSON text frames; OneBot actions are JSON objects.
        }
      } else if (opcode === 0x8) {
        push(null)
      } else if (opcode === 0x9) {
        socket.write(encodeWebSocketFrame(0xa, payload))
      }
    }
  }

  const opened = new Promise((resolve, reject) => {
    const request = client.request(url, {
      method: "GET",
      rejectUnauthorized: false,
      headers: {
        Authorization: `Bearer ${bearer}`,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
      },
    })
    request.once("upgrade", (_response, upgraded, head) => {
      socket = upgraded
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        consume()
      })
      socket.once("error", reject)
      if (head.length) {
        buffer = Buffer.concat([buffer, head])
        consume()
      }
      resolve()
    })
    request.once("response", (response) =>
      reject(new Error(`OneBot WebSocket upgrade returned HTTP ${response.statusCode}`))
    )
    request.once("error", reject)
    request.end()
  })

  return {
    opened,
    send: (value) => socket.write(encodeWebSocketFrame(0x1, JSON.stringify(value))),
    next: (timeoutMs = 120_000) =>
      inbox.length
        ? Promise.resolve(inbox.shift())
        : Promise.race([
            new Promise((resolve) => waiters.push(resolve)),
            delay(timeoutMs).then(() => null),
          ]),
    close: () => socket?.end(encodeWebSocketFrame(0x8)),
  }
}

async function tierIm() {
  log("tier: im")
  const adapterId = process.env.COGNIA_SMOKE_ONEBOT_ADAPTER_ID
  const bearer = process.env.COGNIA_SMOKE_ONEBOT_BEARER
  if (!adapterId || !bearer || !process.env.ANTHROPIC_API_KEY) {
    fatal(
      "--tier im requires COGNIA_SMOKE_ONEBOT_ADAPTER_ID, " +
        "COGNIA_SMOKE_ONEBOT_BEARER, and ANTHROPIC_API_KEY"
    )
  }

  const token = (await composeExec(["cognia-server", "issue-service-token"])).trim()
  const registered = await containerRpc("connectors_list_adapters", {}, token)
  check(
    registered?.adapters?.some(
      (adapter) => adapter.adapter_id === adapterId && adapter.adapter_type === "onebot"
    ),
    `OneBot adapter ${adapterId} is running in the headless brain`
  )
  if (failures) return

  const stub = openOneBotStub(adapterId, bearer)
  await stub.opened
  stub.send({
    time: Math.floor(Date.now() / 1000),
    self_id: 10001,
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    message_id: Date.now(),
    user_id: 20002,
    message: [{ type: "text", data: { text: "Reply with the single word: pong" } }],
    raw_message: "Reply with the single word: pong",
    sender: { user_id: 20002, nickname: "compose-smoke" },
  })

  let outbound = null
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline && !outbound) {
    const action = await stub.next(Math.max(1, deadline - Date.now()))
    if (!action) break
    if (action.action === "send_private_msg") outbound = action
    stub.send({
      status: "ok",
      retcode: 0,
      data:
        action.action === "get_login_info"
          ? { user_id: 10001, nickname: "cognia-smoke" }
          : action.action === "get_version_info"
            ? { app_name: "cognia-smoke", app_version: "1" }
            : { message_id: Date.now() },
      echo: action.echo,
    })
  }
  stub.close()
  check(outbound?.params?.user_id === 20002, "OneBot reply targets the inbound private chat")
  check(
    JSON.stringify(outbound?.params?.message ?? "")
      .toLowerCase()
      .includes("pong"),
    "OneBot outbound action contains the brain's AI reply"
  )
}

/** DPoP device identity from tier 2, reused by tier 3's proxied-WS assertion. */
let tier2Auth = null

async function tierServer() {
  log("tier: server")
  // Self-signed TLS on the published port — scoped to this process; the
  // trust anchor for real clients is the pinned fingerprint (Capacitor) or
  // Caddy (browsers, tier 3).
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"

  const health = await waitForServerHealthz()
  check(
    typeof health.fingerprint === "string" && health.fingerprint.length === 64,
    "healthz reports the TLS fingerprint"
  )
  check(health?.brain?.configured === true, "healthz reports a configured brain")
  const ready = await waitForBrainReady()
  check(ready.status === "ready", "host bootstrap and required runtimes are ready")
  const diagnostics = await waitForServerHealthz()
  check(typeof diagnostics.sidecar?.restart_count === "number", "healthz reports the sidecar block")
  await headlessContractGuards(diagnostics)

  const auth = await pairDevice()
  if (!auth) {
    fatal("pairing failed — cannot continue tier 2")
  }
  tier2Auth = auth
  await dataPlaneRoundtrip(auth)
  await chatTurn(auth)
  await externalAgentTurn()
  await webhookIngressShape()
}

// ---------------------------------------------------------------------------
// Tier 3 — Caddy front door (ADR-0059 F2 / D7)
// ---------------------------------------------------------------------------

const CADDY_URL = process.env.COGNIA_CADDY_URL ?? "https://localhost"

/** Read the peer certificate the front door presents. */
async function peerCertificate(url) {
  const { hostname, port } = new URL(url)
  const tls = await import("node:tls")
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: hostname,
        port: Number(port || 443),
        rejectUnauthorized: false,
        servername: hostname,
      },
      () => {
        const cert = socket.getPeerCertificate()
        socket.end()
        resolve(cert)
      }
    )
    socket.on("error", reject)
    socket.setTimeout(5000, () => {
      socket.destroy()
      reject(new Error("tls connect timeout"))
    })
  })
}

async function tierTls() {
  log("tier: tls")
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"

  // 1. Caddy terminated with ITS OWN chain — not the self-signed
  //    cognia-companion cert (i.e. terminate-and-reproxy actually happened).
  //    With COGNIA_DOMAIN=localhost that is Caddy's internal CA; with a real
  //    domain it's the ACME chain.
  const cert = await peerCertificate(CADDY_URL)
  const issuer = cert?.issuer?.CN ?? cert?.issuer?.O ?? ""
  check(!!issuer, `front door presented a certificate (issuer ${JSON.stringify(issuer)})`)
  check(
    !/cognia-companion/i.test(String(cert?.subject?.CN ?? "")),
    "front door cert is NOT the backend's self-signed cert (re-terminated)"
  )

  // 2. Plain HTTPS through the proxy reaches the backend.
  const health = await fetch(`${CADDY_URL}/healthz`)
  check(health.ok, `GET ${CADDY_URL}/healthz → 200 (got ${health.status})`)

  const authConfigResponse = await fetch(`${CADDY_URL}/api/auth/config`)
  const authConfig = await authConfigResponse.json()
  const expectedSignalingUrl = `${CADDY_URL.replace(/^http/, "ws")}/signaling`
  check(authConfigResponse.ok, "Caddy exposes /api/auth/config")
  check(
    authConfig?.signaling?.url === expectedSignalingUrl,
    `auth config publishes the same-origin signaling URL (${expectedSignalingUrl})`
  )

  // 3. WebSocket upgrade proxies natively.
  if (!tier2Auth) {
    skip("no DPoP device identity from tier 2 — proxied WS upgrade not exercised")
    return
  }
  const ticketPath = "/api/auth/socket-ticket"
  const ticketResponse = await fetch(`${CADDY_URL}${ticketPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tier2Auth.accessToken}`,
      DPoP: await deviceProof(tier2Auth.privateKey, tier2Auth.accessJti, "POST", ticketPath),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: "events" }),
  })
  const { ticket } = await ticketResponse.json()
  check(ticketResponse.ok && typeof ticket === "string", "Caddy issued a single-use WS ticket")
  const wsUp = await new Promise((resolve) => {
    const ws = new WebSocket(
      `${CADDY_URL.replace(/^http/, "ws")}/ws/events?ticket=${encodeURIComponent(ticket)}`
    )
    const timer = setTimeout(() => {
      ws.close()
      resolve(false)
    }, 10_000)
    ws.addEventListener("open", () => {
      clearTimeout(timer)
      ws.close()
      resolve(true)
    })
    ws.addEventListener("error", () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
  check(wsUp, "/ws/events upgrades through the Caddy proxy")

  // 4. The registered mobile role authenticates through Caddy and observes
  // the headless desktop role connected through the compose-internal URL.
  const signaling = signalingWs("mobile-via-caddy", authConfig.signaling.url)
  await signaling.open()
  const challenge = await signaling.next()
  check(challenge?.kind === "challenge", "mobile signaling received a challenge through Caddy")
  signaling.send(await signalingSubscribe(tier2Auth.signalingRoom, "mobile", challenge.challenge))
  const subscribed = await signaling.next(10_000)
  check(subscribed?.kind === "subscribed", "mobile signaling authenticated through Caddy")
  let desktopConnected = subscribed?.peers?.some((peer) => peer?.proof?.role === "desktop") ?? false
  if (!desktopConnected) {
    const joined = await signaling.next(10_000)
    desktopConnected = joined?.kind === "peerJoined" && joined?.peer?.proof?.role === "desktop"
  }
  check(
    desktopConnected,
    "mobile signaling sees the headless desktop peer on the internal endpoint"
  )
  signaling.close()
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tier cloud: the account plane (ADR-0149 unified sign-in)
// ---------------------------------------------------------------------------

const CLOUD_SERVER_URL = process.env.COGNIA_CLOUD_SERVER_URL ?? "https://localhost:27894"
const COLLAB_URL = (process.env.COLLAB_URL ?? "http://localhost:8080").replace(/\/+$/, "")

async function cloudJson(url, init = {}) {
  const response = await fetch(url, init)
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: response.status, body }
}

/** A token for `subject`: the CI fixture mints one, a real Logto needs it pre-minted. */
async function cloudToken(role, subject, audience) {
  const preminted =
    process.env[role === "owner" ? "COGNIA_SMOKE_OWNER_TOKEN" : "COGNIA_SMOKE_MEMBER_TOKEN"]
  if (preminted) return preminted
  const mint = process.env.COGNIA_SMOKE_OIDC_E2E_TOKEN_URL
  if (!mint) return null
  const { status, body } = await cloudJson(mint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sub: subject, aud: audience, scope: "openid" }),
  })
  check(status === 200 && body?.access_token, `fixture mints a token for ${subject}`)
  return body?.access_token ?? null
}

async function cloudMemberships(token) {
  const { status, body } = await cloudJson(`${COLLAB_URL}/v1/account/memberships`, {
    headers: { authorization: `Bearer ${token}` },
  })
  check(status === 200 && Array.isArray(body?.memberships), "GET /v1/account/memberships answers")
  return body?.memberships ?? []
}

async function cloudGrant(token, orgId) {
  const { status, body } = await cloudJson(
    `${COLLAB_URL}/v1/orgs/${encodeURIComponent(orgId)}/grants`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    }
  )
  check(status === 200 && body?.grant, "POST /v1/orgs/{org}/grants exchanges the token for a grant")
  return body?.grant
}

async function tierCloud() {
  log("tier: cloud")
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"

  // 1. The gateway announces a deployment a browser can join.
  const config = await cloudJson(`${CLOUD_SERVER_URL}/api/auth/config`)
  check(config.status === 200, `GET ${CLOUD_SERVER_URL}/api/auth/config answers 200`)
  const auth = config.body ?? {}
  check(auth.deploymentMode === "multi-tenant", "deploymentMode is multi-tenant")
  check(typeof auth.oidc?.issuer === "string", "oidc.issuer is announced")
  check(typeof auth.oidc?.webClientId === "string", "oidc.webClientId is announced")
  check(
    typeof auth.oidc?.nativeClientId === "string",
    "oidc.nativeClientId is announced (desktop + phone)"
  )
  check(
    Array.isArray(auth.oidc?.socialProviders) && auth.oidc.socialProviders.length > 0,
    "at least one social provider is offered"
  )
  check(typeof auth.collaboration?.serviceUrl === "string", "collaboration.serviceUrl is announced")
  check(
    typeof auth.collaboration?.webOrigin === "string",
    "collaboration.webOrigin is announced (invitation links)"
  )
  const audience = auth.oidc?.audience

  // 2. The collaboration server is up.
  const health = await cloudJson(`${COLLAB_URL}/health`)
  check(health.status === 200, `GET ${COLLAB_URL}/health answers 200`)

  // 3. The account plane: claim once, then invite and accept.
  const ownerToken = await cloudToken("owner", "smoke-owner", audience)
  const memberToken = await cloudToken("member", "smoke-member", audience)
  if (!ownerToken || !memberToken) {
    skip(
      "no tokens: set COGNIA_SMOKE_OIDC_E2E_TOKEN_URL (fixture) or COGNIA_SMOKE_OWNER_TOKEN + COGNIA_SMOKE_MEMBER_TOKEN"
    )
    return
  }
  let owned = await cloudMemberships(ownerToken)
  if (owned.length === 0) {
    const credential = process.env.COGNIA_SMOKE_BOOTSTRAP_CREDENTIAL
    if (!credential) {
      skip("deployment unclaimed and COGNIA_SMOKE_BOOTSTRAP_CREDENTIAL unset: claim not exercised")
      return
    }
    const claimed = await cloudJson(`${COLLAB_URL}/v1/account/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        operationId: `smoke-${Date.now()}`,
        credential,
        orgName: "Smoke Org",
        displayName: "Smoke Owner",
      }),
    })
    check(
      claimed.status === 200 && /^org_/.test(claimed.body?.orgId ?? ""),
      "POST /v1/account/bootstrap claims the deployment"
    )
    owned = await cloudMemberships(ownerToken)
  } else {
    log("deployment already claimed: bootstrap skipped")
  }
  check(owned.length >= 1, "the owner holds a membership")
  const orgId = owned[0]?.orgId
  if (!orgId) return

  const grant = await cloudGrant(ownerToken, orgId)
  if (!grant) return
  const invited = await cloudJson(
    `${COLLAB_URL}/v1/orgs/${encodeURIComponent(orgId)}/invitations`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${grant}`, "content-type": "application/json" },
      body: JSON.stringify({ orgRole: "member", reason: "compose smoke" }),
    }
  )
  check(
    invited.status === 200 && typeof invited.body?.token === "string",
    "the owner mints an invitation"
  )
  if (typeof invited.body?.token !== "string") return

  const accepted = await cloudJson(`${COLLAB_URL}/v1/invitations/accept`, {
    method: "POST",
    headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      operationId: `smoke-accept-${Date.now()}`,
      token: invited.body.token,
      displayName: "Smoke Member",
    }),
  })
  check(
    accepted.status === 200 && accepted.body?.orgId === orgId,
    "a second person accepts the invitation into the same org"
  )
  const memberOf = await cloudMemberships(memberToken)
  check(
    memberOf.some((row) => row.orgId === orgId),
    "the member now holds a membership in that org"
  )
  check(
    memberOf.every((row) => row.userId !== owned[0].userId),
    "the member is a different person from the owner"
  )
}

// ---------------------------------------------------------------------------
// Tier: persons — two people of one org on one multi-tenant Host (P6f)
// ---------------------------------------------------------------------------

const PERSONS_SERVER_URL = (process.env.COGNIA_PERSONS_SERVER_URL ?? CLOUD_SERVER_URL).replace(
  /\/+$/,
  ""
)
const PERSONS_TOKEN_URL =
  process.env.COGNIA_SMOKE_OIDC_E2E_TOKEN_URL ?? "http://127.0.0.1:4020/e2e/token"
/** The canonical org every seeded person belongs to (cognia-collab-bootstrap --org-id). */
const PERSONS_ORG_ID = process.env.COGNIA_SMOKE_PERSONS_ORG_ID ?? "org_smoke-persons"
/** The Logto organization the fixture tokens name (--logto-organization-id). */
const PERSONS_LOGTO_ORG = process.env.COGNIA_SMOKE_PERSONS_LOGTO_ORG ?? "logto-smoke-persons"
/** `subject:userId` for exactly two people, as seeded (--identity-subject, --user-id). */
const PERSONS_PEOPLE =
  process.env.COGNIA_SMOKE_PERSONS ?? "smoke-ada:usr_smoke-ada,smoke-bob:usr_smoke-bob"
/**
 * Which of the two is a plain org member (the other is an owner), for the
 * org-administration checks (P6a, AC32). Unset skips the member refusal.
 */
const PERSONS_MEMBER = process.env.COGNIA_SMOKE_PERSONS_MEMBER ?? ""
/**
 * `userId` of an org member seeded in the collaboration plane who never uses
 * the Host, for the check that the usage report lists everyone (P6 item 13).
 * Unset skips that check.
 */
const PERSONS_UNUSED_MEMBER = process.env.COGNIA_SMOKE_PERSONS_UNUSED_MEMBER ?? ""
/**
 * The display name the Host's deployment profile gives the persons model, for
 * the check that it reaches the member's manifest. Unset skips that check.
 */
const PERSONS_MODEL_NAME = process.env.COGNIA_SMOKE_PERSONS_MODEL_NAME ?? ""

/**
 * Whether the Host runs member agents in a gVisor sandbox pool (P6e). Only a
 * Host with `runsc` and a conforming pool can; elsewhere the sandboxed agent
 * turn is reported as skipped. Set to `1` to run it.
 */
const PERSONS_SANDBOX = process.env.COGNIA_SMOKE_PERSONS_SANDBOX === "1"

/**
 * The partition account a Host derives for a person: `pb_` + the first 24 hex
 * of SHA-256(org NUL user) (crates/cognia-companion/src/person_partition.rs).
 */
export function partitionAccountId(orgId, userId) {
  return `pb_${createHash("sha256")
    .update(orgId)
    .update(Buffer.from([0]))
    .update(userId)
    .digest("hex")
    .slice(0, 24)}`
}

export function parsePersons(spec) {
  const people = spec
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [subject, userId] = entry.split(":")
      if (!subject || !userId)
        throw new Error(`COGNIA_SMOKE_PERSONS entry "${entry}" is not subject:userId`)
      return { subject, userId }
    })
  if (people.length !== 2) throw new Error("COGNIA_SMOKE_PERSONS must name exactly two people")
  return people
}

/**
 * One HostState action envelope, addressed to `sessionId`'s channel.
 * `baseRevision` is the channel revision the action builds on (1 after
 * `session.create`); a stale one is answered `host_state_revision_conflict`.
 */
export function hostStateAction(scope, status, sessionId, clientSeq, action, baseRevision) {
  return {
    // sessionStateChannel() in packages/agent-config-types/src/host-state.ts
    channel: `cognia://target/${encodeURIComponent(scope.runtimeTargetId)}/sessions/${encodeURIComponent(sessionId)}`,
    ...scope,
    hostId: status.hostId,
    hostGeneration: status.hostGeneration,
    sessionId,
    clientId: "compose-smoke-persons",
    clientSeq,
    actionId: randomUUID(),
    ...(baseRevision === undefined ? {} : { baseRevision }),
    createdAt: Date.now(),
    action,
  }
}

/** The in-container `cognia-server` for the persons Host (operator side). */
async function personsExec(argv) {
  const prefix = process.env.COGNIA_SMOKE_PERSONS_EXEC
    ? process.env.COGNIA_SMOKE_PERSONS_EXEC.split(/\s+/).filter(Boolean)
    : [
        "docker",
        "compose",
        "-f",
        path.join(REPO_ROOT, "deploy/compose/docker-compose.yml"),
        "-f",
        path.join(REPO_ROOT, "deploy/compose/docker-compose.web-headless-e2e.yml"),
        "--profile",
        "web-headless-e2e",
        "exec",
        "-T",
        "cognia-server-cloud",
      ]
  const { stdout } = await execFile(prefix[0], [...prefix.slice(1), ...argv], {
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout
}

async function personsJson(url, init = {}) {
  const response = await fetch(url, init)
  const text = await response.text()
  try {
    return { status: response.status, body: text ? JSON.parse(text) : null }
  } catch {
    return { status: response.status, body: text }
  }
}

async function personsChallenge() {
  return (
    await personsJson(`${PERSONS_SERVER_URL}/api/auth/device/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: PERSONS_LOGTO_ORG }),
    })
  ).body
}

/** Register one OIDC device for `person` and sign it in: a device auth for {@link rpc}. */
async function pairPerson(person, audience) {
  const minted = await personsJson(PERSONS_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sub: person.subject,
      aud: audience,
      organization_id: PERSONS_LOGTO_ORG,
      client_id: "native-headless-cloud",
      scope: "openid",
    }),
  })
  check(
    minted.status === 200 && minted.body?.access_token,
    `fixture mints a token for ${person.subject}`
  )
  if (!minted.body?.access_token) return null
  const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])
  const signaling = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )
  const deviceId = randomUUID()
  const challenge = await personsChallenge()
  const registered = await personsJson(`${PERSONS_SERVER_URL}/api/auth/device/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${minted.body.access_token}`,
    },
    body: JSON.stringify({
      tenantId: PERSONS_LOGTO_ORG,
      challengeId: challenge.challengeId,
      challengeNonce: challenge.nonce,
      deviceId,
      displayName: `smoke-${person.subject}`,
      publicKeyPem: spkiPem(await webcrypto.subtle.exportKey("spki", keys.publicKey)),
      signalingPublicKey: Buffer.from(
        await webcrypto.subtle.exportKey("raw", signaling.publicKey)
      ).toString("base64url"),
      proof: await deviceProof(
        keys.privateKey,
        challenge.nonce,
        "POST",
        "/api/auth/device/register"
      ),
    }),
  })
  check(
    registered.status === 200,
    registered.status === 200
      ? `${person.subject} registers an OIDC device`
      : `${person.subject} registers an OIDC device (got ${registered.status}: ${JSON.stringify(registered.body)})`
  )
  if (registered.status !== 200) return null
  const tokenChallenge = await personsChallenge()
  const token = await personsJson(`${PERSONS_SERVER_URL}/api/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tenantId: PERSONS_LOGTO_ORG,
      deviceId,
      challengeId: tokenChallenge.challengeId,
      challengeNonce: tokenChallenge.nonce,
      proof: await deviceProof(keys.privateKey, tokenChallenge.nonce, "POST", "/api/auth/token"),
    }),
  })
  check(token.status === 200, `${person.subject} signs the device in (got ${token.status})`)
  if (token.status !== 200) return null
  const claims = JSON.parse(
    Buffer.from(token.body.accessToken.split(".")[1], "base64url").toString()
  )
  return {
    baseUrl: PERSONS_SERVER_URL,
    privateKey: keys.privateKey,
    accessToken: token.body.accessToken,
    accessJti: claims.jti,
  }
}

/** HostState scope + status for a partition, with the manifest's partition marker. */
async function partitionHostState(person) {
  const manifest = await rpc("host_feature_manifest", {}, person.auth)
  const scope = manifest.body?.hostStateScope
  check(
    manifest.status === 200 && manifest.body?.personPartition === true,
    `${person.subject}: host_feature_manifest declares a person partition (got ${manifest.status}: ${JSON.stringify(manifest.body).slice(0, 200)})`
  )
  check(
    scope?.accountId === person.accountId,
    `${person.subject}: HostState scope is the person's own partition ${person.accountId} (got ${scope?.accountId})`
  )
  const status = await rpc("host_state_status", scope, person.auth)
  check(
    status.status === 200 && typeof status.body?.hostId === "string",
    `${person.subject}: host_state_status → 200 (got ${status.status}: ${JSON.stringify(status.body?.details ?? status.body).slice(0, 900)})`
  )
  return scope && status.status === 200 ? { scope, status: status.body } : null
}

/** Submit actions WITHOUT an admin lease, as a partition client does. */
async function submitPartition(person, state, actions) {
  const submit = await rpc("host_state_submit", { ...state.scope, actions }, person.auth)
  check(
    submit.status === 200 && Array.isArray(submit.body?.results),
    `${person.subject}: host_state_submit without a Host admin lease → 200 (got ${submit.status}: ${JSON.stringify(submit.body).slice(0, 300)})`
  )
  return submit.body?.results ?? []
}

async function sessionIds(person) {
  const listed = await rpc("session_list", {}, person.auth)
  check(listed.status === 200, `${person.subject}: session_list → 200 (got ${listed.status})`)
  return new Set((listed.body?.items ?? []).map((row) => row.id))
}

const FIXTURE_REPLY = "[web-headless-e2e] deterministic assistant reply"

// The org model the persons tier talks to. Unset, it is the repo's Anthropic
// fixture (deterministic reply). Set, it is a real deployment the Host's
// provider profiles already carry, and a reply is any non-empty assistant text.
const PERSONS_MODEL = process.env.COGNIA_SMOKE_PERSONS_PROVIDER
  ? {
      provider: process.env.COGNIA_SMOKE_PERSONS_PROVIDER,
      model: process.env.COGNIA_SMOKE_PERSONS_MODEL ?? "",
      apiKey: process.env.COGNIA_SMOKE_PERSONS_API_KEY ?? "",
      real: true,
    }
  : { provider: "anthropic", model: "claude-e2e", apiKey: "", real: false }

/**
 * How long a turn the gateway refuses outright may take to fail. Retries of
 * the refusal (the AI SDK's three attempts, Claude Code's own backoff) blow
 * through these; a sandboxed agent first has to start, hence the larger one.
 */
const PERSONS_REFUSAL_MAX_MS = 5_000
const PERSONS_AGENT_REFUSAL_MAX_MS = 45_000

/**
 * The member's usage once nothing of theirs is still in flight. A request the
 * gateway admitted before a new cap settles its reservation afterwards, so a
 * "before" read taken earlier counts tokens the capped turn never spent.
 */
async function personsSettledUsage(owner, person, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const usage = await rpc("org_member_usage_get", {}, owner.auth)
    const row = (usage.body?.members ?? []).find((member) => member.userId === person.userId)
    if (!row || row.reservedTokens === 0 || Date.now() > deadline) return usage
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

function personsOrgKey() {
  return PERSONS_MODEL.apiKey || `smoke-${PERSONS_MODEL.provider}-${randomUUID()}`
}

/** Whether a turn's persisted messages carry a model reply. */
function personsReplied(turn) {
  if (!PERSONS_MODEL.real) return turn.text.includes(FIXTURE_REPLY)
  return turn.messages.some(
    (message) =>
      message?.role === "assistant" &&
      (message.parts ?? []).some(
        (part) => part?.type === "text" && typeof part.text === "string" && part.text.trim()
      )
  )
}

/** The assistant text a turn left in the transcript. */
function personsReplyText(turn) {
  return turn.messages
    .filter((message) => message?.role === "assistant")
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
}

/** Enqueue one message on a fresh chat session and wait for its turn to settle. */
/**
 * One member turn in a fresh conversation. `modelPick`, when given, is sent
 * as a `session.model` intent between the create and the message, the way a
 * member's model menu switches a conversation on the Host.
 */
async function personsTurn(person, seed, text, waitSeconds = 30, modelPick) {
  const startedAt = Date.now()
  const sessionId = `smoke-chat-${person.subject}-${randomUUID()}`
  const [created] = await submitPartition(person, person.state, [
    hostStateAction(person.state.scope, person.state.status, sessionId, 1, {
      kind: "session.create",
      title: "Smoke chat",
      seed,
    }),
  ])
  check(
    created?.outcome === "applied",
    `${person.subject}: chat session created (got ${JSON.stringify(created)})`
  )
  if (modelPick) {
    const [picked] = await submitPartition(person, person.state, [
      hostStateAction(person.state.scope, person.state.status, sessionId, 2, {
        kind: "session.model",
        ...modelPick,
      }),
    ])
    check(
      picked?.outcome === "applied",
      `${person.subject}: session.model is applied (got ${JSON.stringify(picked)})`
    )
  }
  const enqueue = hostStateAction(
    person.state.scope,
    person.state.status,
    sessionId,
    modelPick ? 3 : 2,
    { kind: "message.enqueue", messageId: randomUUID(), text, attachments: [] },
    1
  )
  const [enqueued] = await submitPartition(person, person.state, [enqueue])
  check(
    enqueued && enqueued.outcome !== "rejected",
    `${person.subject}: message.enqueue is accepted (got ${JSON.stringify(enqueued)})`
  )
  let messages = []
  for (let attempt = 0; attempt < waitSeconds; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const page = await rpc("message_get_by_session", { session_id: sessionId }, person.auth)
    messages = page.body?.items ?? page.body ?? []
    const text = JSON.stringify(messages)
    if (text.includes(FIXTURE_REPLY) || /"(error|failed|errorCode)"/.test(text)) break
    const fate = await personsTurnFate(person, enqueue)
    if (fate.operation?.status === "failed" || fate.turn?.endsWith("-error")) break
    if (fate.turn === "completed" && personsReplied({ messages, text })) break
  }
  const { operation, turn, turnErrorCode, queued } = await personsTurnFate(person, enqueue)
  return {
    sessionId,
    queued,
    messages,
    text: JSON.stringify(messages),
    operation,
    turn,
    turnErrorCode,
    elapsedMs: Date.now() - startedAt,
  }
}

/**
 * A conversation created with no title takes its first message's opening words
 * in the Host's channel, not only on its `sessions` row (plan §9b item 15).
 * Before, every replica wrote the channel's "New conversation" back over the
 * preview on each confirmed update.
 */
async function personsFirstMessageTitle(person, seed) {
  const sessionId = `smoke-title-${person.subject}-${randomUUID()}`
  const [created] = await submitPartition(person, person.state, [
    hostStateAction(person.state.scope, person.state.status, sessionId, 1, {
      kind: "session.create",
      seed,
    }),
  ])
  check(
    created?.outcome === "applied",
    `${person.subject}: untitled session created (got ${JSON.stringify(created)})`
  )
  // A topic, not a title: the model's title then reads unlike the message.
  const text = "Explain   in one sentence why the sky looks blue at noon but red at sunset"
  const enqueue = hostStateAction(
    person.state.scope,
    person.state.status,
    sessionId,
    2,
    { kind: "message.enqueue", messageId: randomUUID(), text, attachments: [] },
    1
  )
  const [enqueued] = await submitPartition(person, person.state, [enqueue])
  check(
    enqueued && enqueued.outcome !== "rejected",
    `${person.subject}: first message of the untitled session is accepted (got ${JSON.stringify(enqueued)})`
  )
  const snapshot = await rpc(
    "host_state_snapshot",
    {
      accountId: person.state.scope.accountId,
      runtimeTargetId: person.state.scope.runtimeTargetId,
      channel: enqueue.channel,
    },
    person.auth
  )
  // `instantSessionTitle` in lib/chat/placeholder-title.ts.
  const expected = text.replace(/\s+/g, " ").trim().slice(0, 40)
  check(
    snapshot.body?.state?.title === expected,
    `${person.subject}: the Host names an untitled conversation from its first message (got ${JSON.stringify(snapshot.body?.state?.title)})`
  )
  // Once the first turn completes, the org's model writes the conversation's
  // title (plan §9b item 18). The fixture's canned reply titles nothing worth
  // telling apart from the preview, so only a real model is held to it.
  if (!PERSONS_MODEL.real) {
    skip(`${person.subject}: model-written title (needs COGNIA_SMOKE_PERSONS_PROVIDER)`)
    return
  }
  let titled
  for (let attempt = 0; attempt < 60; attempt++) {
    const read = await rpc(
      "host_state_snapshot",
      {
        accountId: person.state.scope.accountId,
        runtimeTargetId: person.state.scope.runtimeTargetId,
        channel: enqueue.channel,
      },
      person.auth
    )
    titled = read.body?.state?.title
    if (typeof titled === "string" && titled && titled !== expected) break
    await delay(1000)
  }
  // Not a cut of the message: that is all the preview, or a truncation, is.
  const typed = text.replace(/\s+/g, " ").trim().toLowerCase()
  check(
    typeof titled === "string" &&
      titled.trim().length > 0 &&
      titled !== expected &&
      !typed.startsWith(titled.trim().toLowerCase()) &&
      titled.length <= 80,
    `${person.subject}: the org's model titles the conversation after its first turn (got ${JSON.stringify(titled)})`
  )
}

/**
 * Two messages sent back to back into one conversation, the second while the
 * first turn runs: what a member's device does now that the Host offers it no
 * steering. The Host queues the second and runs it when the first settles.
 */
async function personsFollowUp(person, seed, waitSeconds = 60) {
  const sessionId = `smoke-follow-${person.subject}-${randomUUID()}`
  const [created] = await submitPartition(person, person.state, [
    hostStateAction(person.state.scope, person.state.status, sessionId, 1, {
      kind: "session.create",
      title: "Smoke follow-up",
      seed,
    }),
  ])
  check(
    created?.outcome === "applied",
    `${person.subject}: follow-up session created (got ${JSON.stringify(created)})`
  )
  const send = (clientSeq, text, baseRevision) =>
    hostStateAction(
      person.state.scope,
      person.state.status,
      sessionId,
      clientSeq,
      { kind: "message.enqueue", messageId: randomUUID(), text, attachments: [] },
      baseRevision
    )
  const first = send(2, "first message: reply with one short sentence", 1)
  const [firstReceipt] = await submitPartition(person, person.state, [first])
  const snapshot = await rpc(
    "host_state_snapshot",
    {
      accountId: person.state.scope.accountId,
      runtimeTargetId: person.state.scope.runtimeTargetId,
      channel: first.channel,
    },
    person.auth
  )
  const second = send(
    3,
    "second message, sent while the first runs: reply with one short sentence",
    snapshot.body?.state?.revision
  )
  const [secondReceipt] = await submitPartition(person, person.state, [second])
  check(
    firstReceipt?.outcome !== "rejected" && secondReceipt?.outcome !== "rejected",
    `${person.subject}: both messages are accepted (got ${JSON.stringify([firstReceipt, secondReceipt])})`
  )
  let messages = []
  let fates = []
  for (let attempt = 0; attempt < waitSeconds; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    fates = [await personsTurnFate(person, first), await personsTurnFate(person, second)]
    if (fates.some((fate) => fate.operation?.status === "failed")) break
    const page = await rpc("message_get_by_session", { session_id: sessionId }, person.auth)
    messages = page.body?.items ?? page.body ?? []
    const replies = messages.filter((message) => message?.role === "assistant").length
    if (replies >= 2 && fates.every((fate) => fate.operation?.status === "acknowledged")) break
  }
  return { messages, fates }
}

/** The enqueue's fate and the turn's end state, as a partition client sees them. */
async function personsTurnFate(person, action) {
  const snapshot = await rpc(
    "host_state_snapshot",
    {
      accountId: person.state.scope.accountId,
      runtimeTargetId: person.state.scope.runtimeTargetId,
      channel: action.channel,
    },
    person.auth
  )
  const state = snapshot.body?.state
  return {
    operation: (state?.operations ?? []).find((item) => item.actionId === action.actionId),
    turn: state?.turn,
    turnErrorCode: state?.turnErrorCode,
    queued: (state?.queue ?? []).map((item) => item.actionId),
  }
}

async function personsChat(person, owner) {
  const seed = { provider: PERSONS_MODEL.provider, model: PERSONS_MODEL.model }
  await rpc("org_model_credential_delete", { provider: PERSONS_MODEL.provider }, owner.auth)
  const keyless = await personsTurn(person, seed, "hello without a key")
  check(
    keyless.operation?.status === "failed" &&
      keyless.operation.errorCode === "model_access_unavailable",
    `${person.subject}: a turn without an org key fails model_access_unavailable (got ${JSON.stringify(keyless.operation)})`
  )
  const stored = await rpc(
    "org_model_credential_set",
    { provider: PERSONS_MODEL.provider, apiKey: personsOrgKey() },
    owner.auth
  )
  check(
    stored.status === 200,
    `the owner stores a ${PERSONS_MODEL.provider} org key (got ${stored.status})`
  )
  const before = await rpc("org_member_usage_get", {}, owner.auth)
  const reply = await personsTurn(person, seed, "hello with the org key")
  check(personsReplied(reply), `${person.subject} gets a model reply through the org key`)
  check(
    reply.turn === "completed",
    `${person.subject}'s keyed turn settles completed (got ${reply.turn})`
  )
  check(
    reply.operation?.status === "acknowledged" && reply.queued.length === 0,
    `${person.subject}'s delivered message settles acknowledged and leaves the queue (got ${JSON.stringify(reply.operation)}, queue ${JSON.stringify(reply.queued)})`
  )
  const after = await rpc("org_member_usage_get", {}, owner.auth)
  const spent = (body) =>
    (body?.members ?? []).find((member) => member.userId === person.userId)?.spentTokens ?? 0
  check(
    spent(after.body) > spent(before.body),
    `${person.subject}'s usage grows with the reply (${spent(before.body)} → ${spent(after.body)})`
  )
  // A model the org's deployment does not serve is no model access, not a
  // malformed request; picking a served one on the Host (`session.model`)
  // makes the same conversation's next turn run.
  const unserved = { provider: PERSONS_MODEL.provider, model: "smoke-unserved-model" }
  const refusedModel = await personsTurn(person, unserved, "hello on a model the org lacks")
  check(
    refusedModel.operation?.status === "failed" &&
      refusedModel.operation.errorCode === "model_access_unavailable",
    `${person.subject}: an unserved model fails model_access_unavailable (got ${JSON.stringify(refusedModel.operation)})`
  )
  const switched = await personsTurn(person, unserved, "hello after picking a served model", 30, {
    provider: PERSONS_MODEL.provider,
    model: PERSONS_MODEL.model,
  })
  check(
    personsReplied(switched) && switched.turn === "completed",
    `${person.subject}'s turn runs on the model picked through session.model (got ${switched.turn}, ${JSON.stringify(switched.operation)})`
  )
  await personsFirstMessageTitle(person, seed)
  const followUp = await personsFollowUp(person, seed)
  const replies = followUp.messages.filter((message) => message?.role === "assistant")
  const sent = followUp.messages.filter((message) => message?.role === "user")
  check(
    replies.length >= 2 &&
      sent.length >= 2 &&
      followUp.fates.every((fate) => fate.operation?.status === "acknowledged"),
    `${person.subject}: a message sent mid-turn runs as the next turn and both stay in the transcript (sent ${sent.length}, replies ${replies.length}, ${JSON.stringify(followUp.fates)})`
  )
  // The usage panel names people: the Host asks the org's collaboration plane.
  const named = await rpc("org_member_usage_get", {}, owner.auth)
  const namedRow = (named.body?.members ?? []).find((member) => member.userId === person.userId)
  check(
    named.status === 200 &&
      typeof namedRow?.displayName === "string" &&
      namedRow.displayName.trim().length > 0,
    `${owner.subject} (owner): the usage report names ${person.subject} (got ${named.status}: ${JSON.stringify(namedRow)})`
  )
  // It lists the whole org, from the same plane answer, not only people who
  // already used the Host: the owner can cap someone before their first turn.
  check(
    named.body?.membersIncomplete === undefined &&
      [owner, person].every((who) =>
        (named.body?.members ?? []).some((member) => member.userId === who.userId)
      ),
    `${owner.subject} (owner): the usage report lists every member it was asked for (got ${JSON.stringify(named.body?.members?.map((member) => member.userId))}, incomplete ${named.body?.membersIncomplete})`
  )
  if (PERSONS_UNUSED_MEMBER) {
    const unused = (named.body?.members ?? []).find(
      (member) => member.userId === PERSONS_UNUSED_MEMBER
    )
    check(
      unused?.spentTokens === 0 &&
        typeof unused.displayName === "string" &&
        unused.displayName.trim().length > 0,
      `${owner.subject} (owner): the usage report names ${PERSONS_UNUSED_MEMBER}, who never used the Host (got ${JSON.stringify(unused)})`
    )
  } else {
    skip(
      "usage report lists a member who never used the Host (COGNIA_SMOKE_PERSONS_UNUSED_MEMBER unset)"
    )
  }
  const capped = await rpc(
    "org_member_usage_cap_set",
    { userId: person.userId, monthlyTokens: 1 },
    owner.auth
  )
  check(capped.status === 200, `the owner caps ${person.subject} at 1 token (got ${capped.status})`)
  const capBefore = await personsSettledUsage(owner, person)
  const overCap = await personsTurn(person, seed, "hello over the cap")
  const capAfter = await personsSettledUsage(owner, person)
  // AC34: the gateway refuses the reservation (429 member_usage_cap_reached)
  // before any provider call, so nothing is spent and the turn ends in error.
  check(!personsReplied(overCap), `${person.subject} gets no reply over the cap`)
  check(
    overCap.turn === "fatal-error",
    `${person.subject}'s over-cap turn settles fatal-error (got ${overCap.turn})`
  )
  // The member's devices learn why, and the refusal is not retried: the
  // gateway answers it before any provider call, so it fails at once.
  check(
    overCap.turnErrorCode === "member_usage_cap_reached",
    `${person.subject}'s over-cap turn says member_usage_cap_reached (got ${overCap.turnErrorCode})`
  )
  check(
    overCap.elapsedMs < PERSONS_REFUSAL_MAX_MS,
    `${person.subject}'s over-cap turn fails without retrying (${overCap.elapsedMs} ms)`
  )
  check(
    spent(capAfter.body) === spent(capBefore.body),
    `${person.subject} spends nothing over the cap (${spent(capBefore.body)} → ${spent(capAfter.body)})`
  )
  await rpc(
    "org_member_usage_cap_set",
    { userId: person.userId, monthlyTokens: "default" },
    owner.auth
  )
}

/**
 * A member's sandboxed agent turn (P6e, AC35-AC37): the session names an
 * allowed bundled agent (or takes the org default), the Host runs it in gVisor
 * in the member's personal workspace, and its model calls go through the org
 * key to the fixture (or the real org model). An agent the org does not allow never runs.
 */
/**
 * Watch one person's `/ws/events` for `transcript://live`, which a client
 * must ask for by name, and keep every frame until `stop()`.
 */
async function personsLiveWatch(person) {
  const base = person.auth.baseUrl ?? PERSONS_SERVER_URL
  const ticketPath = "/api/auth/socket-ticket"
  const response = await fetch(`${base}${ticketPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${person.auth.accessToken}`,
      DPoP: await deviceProof(person.auth.privateKey, person.auth.accessJti, "POST", ticketPath),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: "events" }),
  })
  const answer = await response.json().catch(() => ({}))
  const ticket = answer?.ticket
  check(
    response.ok && typeof ticket === "string",
    `${person.subject}: event socket ticket issued (got ${response.status} ${response.ok ? "" : JSON.stringify(answer)})`
  )
  const frames = []
  const ws = new WebSocket(
    `${base.replace(/^http/, "ws")}/ws/events?ticket=${encodeURIComponent(ticket ?? "")}`
  )
  const subscribed = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10_000)
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ type: "subscribe", mode: "add", channels: ["transcript://live"] }))
    )
    ws.addEventListener("message", (event) => {
      let frame
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (frame.type === "subscribed") {
        clearTimeout(timer)
        resolve(frame)
      } else if (frame.type === "transcript://live") frames.push(frame.payload)
    })
    ws.addEventListener("error", () => {
      clearTimeout(timer)
      resolve(null)
    })
  })
  check(
    subscribed?.channels?.includes("transcript://live"),
    `${person.subject} subscribes to transcript://live by name (got ${JSON.stringify(subscribed)})`
  )
  return { frames, stop: () => ws.close() }
}

/** The text of a reply's parts, as a reader sees it. */
function partsText(parts) {
  return (parts ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
}

async function personsAgent(person, owner, other) {
  const stored = await rpc(
    "org_model_credential_set",
    { provider: PERSONS_MODEL.provider, apiKey: personsOrgKey() },
    owner.auth
  )
  check(
    stored.status === 200,
    `the owner stores a ${PERSONS_MODEL.provider} org key (got ${stored.status})`
  )
  const allowOnly = await rpc(
    "org_agent_policy_set",
    { allowedAgents: ["claude-agent-acp"], defaultAgent: null },
    owner.auth
  )
  check(allowOnly.status === 200, `the owner allows claude-agent-acp (got ${allowOnly.status})`)
  const seed = { provider: PERSONS_MODEL.provider, model: PERSONS_MODEL.model }
  const before = await rpc("org_member_usage_get", {}, owner.auth)
  // The reply reaches the member's devices live while it is written, and
  // nobody else's (`transcript://live`).
  const live = await personsLiveWatch(person)
  const witness = other ? await personsLiveWatch(other) : null
  const named = await personsTurn(
    person,
    { ...seed, agentRuntimeId: "claude-agent-acp" },
    "hello from a member agent",
    180
  )
  check(
    personsReplied(named) && named.turn === "completed",
    `${person.subject}'s claude-agent-acp turn replies through the org key (turn ${named.turn}, op ${JSON.stringify(named.operation)})`
  )
  check(
    named.operation?.status === "acknowledged",
    `${person.subject}'s agent message settles acknowledged (got ${JSON.stringify(named.operation)})`
  )
  await new Promise((resolve) => setTimeout(resolve, 500))
  live.stop()
  witness?.stop()
  const frames = live.frames.filter((frame) => frame.sessionId === named.sessionId)
  const settled = frames.find((frame) => frame.state === "settled")
  const kept = (Array.isArray(named.messages) ? named.messages : []).find(
    (message) => message?.id === settled?.messageId
  )
  check(
    frames.length >= 2 &&
      frames[0].keyframe === true &&
      frames[0].state === "streaming" &&
      frames.every((frame, index) => index === 0 || frame.seq > frames[index - 1].seq) &&
      settled?.keyframe === true,
    `${person.subject}'s agent reply streams to their device as live frames (got ${frames
      .map((frame) => `${frame.seq}:${frame.state}${frame.keyframe ? "*" : ""}`)
      .join(" ")})`
  )
  check(
    Boolean(settled) &&
      partsText(settled.parts).length > 0 &&
      partsText(settled.parts) === partsText(kept?.parts),
    `${person.subject}'s final live frame is the reply the Host kept`
  )
  if (witness) {
    check(
      witness.frames.every((frame) => !String(frame.sessionId).includes(person.subject)),
      `${other.subject} receives none of ${person.subject}'s live frames (got ${witness.frames.length})`
    )
  }
  const after = await rpc("org_member_usage_get", {}, owner.auth)
  const spent = (body) =>
    (body?.members ?? []).find((member) => member.userId === person.userId)?.spentTokens ?? 0
  check(
    spent(after.body) > spent(before.body),
    `${person.subject}'s agent usage is charged to them (${spent(before.body)} → ${spent(after.body)})`
  )
  const refused = await personsTurn(
    person,
    { ...seed, agentRuntimeId: "codex-acp" },
    "hello from an agent the org did not allow",
    30
  )
  check(
    refused.operation?.status === "failed" &&
      refused.operation.errorCode === "org_agent_not_allowed" &&
      !personsReplied(refused),
    `an agent the org does not allow is refused org_agent_not_allowed (got ${JSON.stringify(refused.operation)})`
  )
  // P6g: the member's own device learns the same facts from their manifest:
  // the allowed agent, the model the org serves it with, and their own month.
  const manifest = await rpc("host_feature_manifest", {}, person.auth)
  const personAgents = manifest.body?.personAgents
  const claude = personAgents?.allowedAgents?.find(
    (agent) => agent.runtimeId === "claude-agent-acp"
  )
  check(
    claude?.available === true &&
      personAgents.execution === "sandboxed" &&
      (personAgents.models?.[seed.provider] ?? []).includes(seed.model) &&
      (personAgents.usage?.spentTokens ?? 0) >= spent(after.body),
    `${person.subject}'s manifest lists their agent, its org model and their month (got ${JSON.stringify(personAgents)})`
  )
  // Every provider the org holds a key for may appear (tool-less chat runs on
  // any of them); one without an org key never does.
  const keyed = ((await rpc("org_model_credential_list", {}, owner.auth)).body ?? []).map(
    (entry) => entry.provider
  )
  check(
    !JSON.stringify(personAgents ?? {}).includes("usr_") &&
      (claude?.providers ?? []).every((provider) => provider in (personAgents?.models ?? {})) &&
      !Object.keys(personAgents?.models ?? {}).some((provider) => !keyed.includes(provider)),
    `${person.subject}'s manifest names nobody else and no provider the org holds no key for`
  )
  // The deployment's name for the model travels to the member's menu (plan
  // §9b item 16), and names only models the org serves.
  if (PERSONS_MODEL_NAME) {
    check(
      personAgents?.modelNames?.[seed.provider]?.[seed.model] === PERSONS_MODEL_NAME &&
        Object.entries(personAgents?.modelNames ?? {}).every(([provider, names]) =>
          Object.keys(names).every((id) => (personAgents.models?.[provider] ?? []).includes(id))
        ),
      `${person.subject}'s manifest names ${seed.model} "${PERSONS_MODEL_NAME}" (got ${JSON.stringify(personAgents?.modelNames)})`
    )
  } else {
    skip("model display names (COGNIA_SMOKE_PERSONS_MODEL_NAME unset)")
  }
  const withDefault = await rpc(
    "org_agent_policy_set",
    { allowedAgents: ["claude-agent-acp"], defaultAgent: "claude-agent-acp" },
    owner.auth
  )
  check(
    withDefault.status === 200,
    `the owner makes claude-agent-acp the default (got ${withDefault.status})`
  )
  const byDefault = await personsTurn(person, seed, "hello from the default agent", 180)
  check(
    personsReplied(byDefault) && byDefault.turn === "completed",
    `a session without an agent runs the org default (turn ${byDefault.turn}, op ${JSON.stringify(byDefault.operation)})`
  )
  await rpc(
    "org_agent_policy_set",
    { allowedAgents: ["claude-agent-acp"], defaultAgent: null },
    owner.auth
  )
  // Over the cap, the agent's own SDK must not retry the gateway's refusal,
  // and the member's devices learn why the turn ended.
  const capped = await rpc(
    "org_member_usage_cap_set",
    { userId: person.userId, monthlyTokens: 1 },
    owner.auth
  )
  check(capped.status === 200, `the owner caps ${person.subject} at 1 token (got ${capped.status})`)
  const capBefore = await personsSettledUsage(owner, person)
  const overCap = await personsTurn(
    person,
    { ...seed, agentRuntimeId: "claude-agent-acp" },
    "hello from an agent over the cap",
    180
  )
  const capAfter = await personsSettledUsage(owner, person)
  await rpc(
    "org_member_usage_cap_set",
    { userId: person.userId, monthlyTokens: "default" },
    owner.auth
  )
  check(
    !personsReplied(overCap) &&
      overCap.turn === "fatal-error" &&
      overCap.turnErrorCode === "member_usage_cap_reached",
    `${person.subject}'s agent turn over the cap ends member_usage_cap_reached (turn ${overCap.turn}, code ${overCap.turnErrorCode}, op ${JSON.stringify(overCap.operation)}, reply ${JSON.stringify(personsReplyText(overCap).slice(0, 200))})`
  )
  check(
    overCap.elapsedMs < PERSONS_AGENT_REFUSAL_MAX_MS,
    `${person.subject}'s agent turn over the cap fails without retrying (${overCap.elapsedMs} ms)`
  )
  check(
    spent(capAfter.body) === spent(capBefore.body),
    `${person.subject}'s agent spends nothing over the cap (${spent(capBefore.body)} → ${spent(capAfter.body)})`
  )
}

async function tierPersons() {
  log("tier: persons")
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
  const config = await personsJson(`${PERSONS_SERVER_URL}/api/auth/config`)
  check(
    config.status === 200 && config.body?.deploymentMode === "multi-tenant",
    `${PERSONS_SERVER_URL} is a multi-tenant Host (got ${config.status}: ${config.body?.deploymentMode})`
  )
  const audience = config.body?.oidc?.audience
  if (typeof audience !== "string") {
    check(false, "the Host announces its OIDC audience")
    return
  }
  const people = parsePersons(PERSONS_PEOPLE).map((person) => ({
    ...person,
    accountId: partitionAccountId(PERSONS_ORG_ID, person.userId),
  }))
  for (const person of people) person.auth = await pairPerson(person, audience)
  if (people.some((person) => !person.auth)) return
  const [ada, bob] = people

  // 1. Each person's HostState is their own partition, and accepts data
  //    intents with no Host admin lease (P5d, AC29).
  for (const person of people) {
    person.state = await partitionHostState(person)
    if (!person.state) return
    person.sessionId = `smoke-${person.subject}-${randomUUID()}`
    const [created] = await submitPartition(person, person.state, [
      hostStateAction(person.state.scope, person.state.status, person.sessionId, 1, {
        kind: "session.create",
        title: `Smoke ${person.subject}`,
      }),
    ])
    check(
      created?.outcome === "applied",
      `${person.subject}: session.create applied (got ${JSON.stringify(created)})`
    )
  }
  const [renamed] = await submitPartition(ada, ada.state, [
    hostStateAction(
      ada.state.scope,
      ada.state.status,
      ada.sessionId,
      2,
      { kind: "session.rename", title: "Smoke Ada renamed" },
      1
    ),
  ])
  check(
    renamed?.outcome === "applied",
    `ada: session.rename applied (got ${JSON.stringify(renamed)})`
  )

  // 2. Isolation (AC25): neither person sees the other's sessions or rows.
  const adaSessions = await sessionIds(ada)
  const bobSessions = await sessionIds(bob)
  check(adaSessions.has(ada.sessionId), "ada's session_list has her conversation")
  check(bobSessions.has(bob.sessionId), "bob's session_list has his conversation")
  check(
    !adaSessions.has(bob.sessionId) && !bobSessions.has(ada.sessionId),
    "neither session_list shows the other person's conversation"
  )
  const marker = `ADA-SMOKE-${randomUUID().slice(0, 8)}`
  const upsert = await rpc(
    "character_upsert",
    { draft: { name: marker, description: "ada only" } },
    ada.auth
  )
  check(upsert.status === 200, `ada: character_upsert → 200 (got ${upsert.status})`)
  const characterNames = async (person) =>
    ((await rpc("sync_pull", { table: "characters", since: 0 }, person.auth)).body?.rows ?? []).map(
      (row) => row.name ?? row.data?.name
    )
  check((await characterNames(ada)).includes(marker), "ada's sync_pull returns her character")
  check(
    !(await characterNames(bob)).includes(marker),
    "bob's sync_pull does not return ada's character"
  )

  // 3. Intentional dormancy (Rule 7): workspaces stay refused, and so does
  //    chat on a Host older than P6c, which does not advertise tool-less chat.
  const manifest = await rpc("host_feature_manifest", {}, ada.auth)
  const toolLessChat = (manifest.body?.operations ?? []).some(
    (operation) => operation.feature === "claude.tool-less-chat" && operation.healthy === true
  )
  const refused = await submitPartition(ada, ada.state, [
    ...(toolLessChat
      ? []
      : [
          hostStateAction(ada.state.scope, ada.state.status, ada.sessionId, 3, {
            kind: "message.enqueue",
            messageId: randomUUID(),
            text: "hello",
            attachments: [],
          }),
        ]),
    hostStateAction(ada.state.scope, ada.state.status, ada.sessionId, 4, {
      kind: "session.workspace",
      projectId: "smoke-project",
    }),
  ])
  if (!toolLessChat) {
    check(
      JSON.stringify(refused[0] ?? null).includes("execution_isolation_unavailable"),
      `message.enqueue is refused execution_isolation_unavailable (got ${JSON.stringify(refused[0])})`
    )
  }
  check(
    JSON.stringify(refused.at(-1) ?? null).includes("workspace_unavailable"),
    `session.workspace is refused workspace_unavailable (got ${JSON.stringify(refused.at(-1))})`
  )
  const pet = await rpc(
    "pet_chat_send",
    { text: "hi", locale: "en", idempotencyKey: randomUUID() },
    bob.auth
  )
  // No headless brain has a pet: from P6c the person brain answers it like
  // any headless Host; before, the Host refused it as model dormancy.
  check(
    toolLessChat
      ? JSON.stringify(pet.body ?? null).includes("headless-host")
      : pet.status === 503 && JSON.stringify(pet.body).includes("model_access_unavailable"),
    `pet_chat_send answers ${toolLessChat ? "headless-host" : "503 model_access_unavailable"} (got ${pet.status}: ${JSON.stringify(pet.body).slice(0, 200)})`
  )

  // 4. Org administration (P6a/P6b, AC32): an owner writes on live standing
  //    alone (no Host consent, no lease), reads metadata only, and a plain
  //    member is refused.
  const owner = people.find((person) => person.subject !== PERSONS_MEMBER)
  const listedKeys = await rpc("org_model_credential_list", {}, owner.auth)
  check(
    listedKeys.status === 200 && Array.isArray(listedKeys.body),
    `${owner.subject} (owner): org_model_credential_list → 200 (got ${listedKeys.status}: ${JSON.stringify(listedKeys.body).slice(0, 200)})`
  )
  const smokeKey = `smoke-org-key-${randomUUID()}`
  const stored = await rpc(
    "org_model_credential_set",
    { provider: "openai", apiKey: smokeKey },
    owner.auth
  )
  check(
    stored.status === 200 &&
      stored.body?.provider === "openai" &&
      typeof stored.body?.fingerprint === "string" &&
      !JSON.stringify(stored.body).includes(smokeKey),
    `${owner.subject} (owner): org_model_credential_set → 200 with metadata and no key echo (got ${stored.status}: ${JSON.stringify(stored.body).slice(0, 200)})`
  )
  const relisted = await rpc("org_model_credential_list", {}, owner.auth)
  check(
    (relisted.body ?? []).some((row) => row.provider === "openai") &&
      (relisted.body ?? []).every((row) => !("apiKey" in row) && !("value" in row)) &&
      !JSON.stringify(relisted.body).includes(smokeKey),
    "org credential rows carry metadata only"
  )
  const policy = await rpc(
    "org_agent_policy_set",
    { allowedAgents: ["claude-agent-acp"], defaultAgent: "claude-agent-acp" },
    owner.auth
  )
  const bundled = policy.body?.bundledAgents ?? []
  check(
    policy.status === 200 &&
      policy.body?.defaultAgent === "claude-agent-acp" &&
      bundled.some((agent) => agent.runtimeId === "claude-agent-acp" && agent.available === true) &&
      bundled.some((agent) => agent.runtimeId === "codex-acp"),
    `${owner.subject} (owner): org_agent_policy_set → 200, lists every bundled agent, claude served by an org key (got ${policy.status}: ${JSON.stringify(policy.body).slice(0, 300)})`
  )
  const capSet = await rpc("org_usage_cap_set", { defaultMonthlyTokens: 1_000_000 }, owner.auth)
  const usage = await rpc("org_member_usage_get", {}, owner.auth)
  check(
    capSet.status === 200 &&
      usage.status === 200 &&
      usage.body?.defaultMonthlyTokens === 1_000_000 &&
      Array.isArray(usage.body?.members),
    `${owner.subject} (owner): org_usage_cap_set + org_member_usage_get → 200 with the default cap (got ${capSet.status}/${usage.status}: ${JSON.stringify(usage.body).slice(0, 200)})`
  )
  const capCleared = await rpc("org_usage_cap_set", { defaultMonthlyTokens: null }, owner.auth)
  check(
    capCleared.status === 200,
    `the default cap returns to unlimited (got ${capCleared.status})`
  )
  // Any org key serves a brokered agent, so the allowed agent stays
  // available exactly while some other key remains.
  const removed = await rpc("org_model_credential_delete", { provider: "openai" }, owner.auth)
  const remaining = (await rpc("org_model_credential_list", {}, owner.auth)).body ?? []
  const afterRemove = await rpc("org_agent_policy_get", {}, owner.auth)
  check(
    removed.status === 200 &&
      !remaining.some((row) => row.provider === "openai") &&
      (afterRemove.body?.allowedAgents ?? []).every(
        (agent) => agent.available === remaining.length > 0
      ),
    `removing the key updates the allowed agent's availability (got ${removed.status}: ${JSON.stringify(afterRemove.body).slice(0, 200)})`
  )
  const selected = await rpc("org_model_credential_list", { orgId: "org_someone-else" }, owner.auth)
  check(selected.status === 403, `a device cannot select another org (got ${selected.status})`)
  if (PERSONS_MEMBER) {
    const member = people.find((person) => person.subject === PERSONS_MEMBER)
    const refusedList = await rpc("org_model_credential_list", {}, member.auth)
    check(
      refusedList.status === 403,
      `${member.subject} (member): org_model_credential_list is refused (got ${refusedList.status})`
    )
    const refusedPolicy = await rpc(
      "org_agent_policy_set",
      { allowedAgents: ["claude-agent-acp"], defaultAgent: "claude-agent-acp" },
      member.auth
    )
    check(
      refusedPolicy.status === 403,
      `${member.subject} (member): org_agent_policy_set is refused (got ${refusedPolicy.status})`
    )
    const refusedKey = await rpc(
      "org_model_credential_set",
      { provider: "openai", apiKey: "smoke-member-key" },
      member.auth
    )
    check(
      refusedKey.status === 403 && !JSON.stringify(refusedKey.body).includes("smoke-member-key"),
      `${member.subject} (member): org_model_credential_set is refused without an echo (got ${refusedKey.status})`
    )
    const refusedUsage = await rpc("org_member_usage_get", {}, member.auth)
    check(
      refusedUsage.status === 403,
      `${member.subject} (member): org_member_usage_get is refused (got ${refusedUsage.status})`
    )
  } else {
    skip("COGNIA_SMOKE_PERSONS_MEMBER unset: member refusal not exercised")
  }

  // 4b. Tool-less member chat (P6c, AC33/AC34): a member's turn runs on an
  //     org key through a partition ticket, is charged to that member, and
  //     fails with a clear code without a key or over the cap.
  //     With no default agent the org's members stay on tool-less chat.
  await rpc(
    "org_agent_policy_set",
    { allowedAgents: ["claude-agent-acp"], defaultAgent: null },
    owner.auth
  )
  if (toolLessChat) await personsChat(ada, owner)
  else skip("the Host does not advertise tool-less member chat (pre-P6c)")

  // 4c. Sandboxed member agents (P6e): needs gVisor and a conforming pool.
  if (PERSONS_SANDBOX) await personsAgent(ada, owner, bob)
  else skip("COGNIA_SMOKE_PERSONS_SANDBOX unset: sandboxed member agent turn not exercised")

  // 5. The operator sees one partition per person, then purges bob (AC27):
  //    his next request starts an empty partition and ada keeps hers.
  let listed = null
  try {
    listed = JSON.parse(await personsExec(["cognia-server", "persons", "list"]))
  } catch (error) {
    check(false, `cognia-server persons list answers JSON (${error.message})`)
  }
  const listedIds = new Set((listed?.persons ?? []).map((row) => row.accountId))
  check(
    people.every((person) => listedIds.has(person.accountId)),
    `persons list shows both partitions (got ${[...listedIds].join(", ")})`
  )
  try {
    await personsExec([
      "cognia-server",
      "persons",
      "purge",
      "--org",
      PERSONS_ORG_ID,
      "--user",
      bob.userId,
    ])
    check(true, "cognia-server persons purge removes bob's partition")
  } catch (error) {
    check(false, `cognia-server persons purge removes bob's partition (${error.message})`)
  }
  check(!(await sessionIds(bob)).has(bob.sessionId), "after purge bob rejoins an empty partition")
  check((await sessionIds(ada)).has(ada.sessionId), "after bob's purge ada's partition is intact")
}

async function main() {
  const tier = parseTier()
  if (tier === "cloud" || tier === "persons") {
    await (tier === "cloud" ? tierCloud() : tierPersons())
    if (failures > 0) fatal(`${failures} check(s) failed`)
    log("OK — all checks passed")
    return
  }
  await tierServices()
  if (tier === "server" || tier === "tls" || tier === "im") await tierServer()
  if (tier === "tls") await tierTls()
  if (tier === "im") await tierIm()

  if (failures > 0) fatal(`${failures} check(s) failed`)
  log("OK — all checks passed")
}

/**
 * The pairing and RPC helpers, for smokes that drive the same server tier
 * (`compose-runtime-environment.mjs`). A check that fails inside one of them
 * is counted here; {@link smokeFailureCount} lets the importer include it.
 */
export {
  composeExec,
  containerRpc,
  containerRpcResponse,
  deviceProof,
  pairDevice,
  rpc,
  SERVER_URL,
  signalingRelay,
  waitForServerHealthz,
}

export function smokeFailureCount() {
  return failures
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[smoke] FAIL (uncaught):", err)
    process.exit(1)
  })
}
