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
 */

import process from "node:process"
import { randomBytes, webcrypto } from "node:crypto"
import { execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"

const execFile = promisify(execFileCb)

if (typeof globalThis.WebSocket !== "function") {
  console.error("[smoke] FAIL: globalThis.WebSocket is undefined — needs Node 22+")
  process.exit(1)
}

// ---------------------------------------------------------------------------
// CLI + helpers
// ---------------------------------------------------------------------------

const TIERS = ["services", "server", "tls"]
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

function signalingWs(label) {
  const ws = new WebSocket(`${SIGNALING_URL.replace(/^http/, "ws")}/v2/signaling`)
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
  await a.open()
  await b.open()
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

/** Device-JWT RPC against the published port. */
async function rpc(name, args, jwt) {
  const res = await fetch(`${SERVER_URL}/api/v1/_rpc/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {}),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

/** Loopback RPC from inside the container (service scope). */
async function containerRpc(name, args, token) {
  const out = await composeExec([
    "curl",
    "-sk",
    "-X",
    "POST",
    `https://127.0.0.1:27890/api/v1/_rpc/${name}`,
    "-H",
    `Authorization: Bearer ${token}`,
    "-H",
    "Content-Type: application/json",
    "-d",
    JSON.stringify(args ?? {}),
  ])
  try {
    return JSON.parse(out)
  } catch {
    return out.trim()
  }
}

async function waitForServerHealthz() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${SERVER_URL}/api/v1/healthz`)
      if (res.ok) return await res.json()
    } catch {
      // not up yet
    }
    await delay(2000)
  }
  fatal(`${SERVER_URL}/api/v1/healthz did not become healthy in 120s`)
}

async function waitForBrainReady() {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${SERVER_URL}/api/v1/healthz`).catch(() => null)
    if (res?.ok) {
      const body = await res.json()
      if (body?.brain?.ready === true) return body
    }
    await delay(2000)
  }
  fatal("brain never completed the bridge hello (healthz brain.ready stayed false)")
}

async function pairDevice() {
  const out = await composeExec(["cognia-server", "pair", "--device-name", "smoke"])
  const match = out.match(/cgnp2\|([A-Za-z0-9_-]+)/)
  check(!!match, "pair subcommand printed a cgnp2 payload")
  if (!match) return null
  const payload = JSON.parse(Buffer.from(match[1], "base64url").toString())
  check(typeof payload.pairJwt === "string", "pair payload carries pairJwt")

  const res = await fetch(`${SERVER_URL}/api/v1/auth/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pairJwt: payload.pairJwt,
      deviceLabel: "compose-smoke",
      devicePlatform: "smoke",
      devicePubkey: "none",
      appVersion: "0.0.0",
    }),
  })
  check(res.status === 200, `POST /api/v1/auth/pair → 200 (got ${res.status})`)
  const body = await res.json()
  check(typeof body.deviceJwt === "string", "pair redeem returned a device JWT")
  return body.deviceJwt
}

async function dataPlaneRoundtrip(jwt) {
  const pull = await rpc("sync_pull", { table: "sessions", since: 0 }, jwt)
  check(pull.status === 200, `sync_pull → 200 (got ${pull.status}: ${JSON.stringify(pull.body)})`)
  check(Array.isArray(pull.body?.rows), "sync_pull delta has rows[] (answered by the brain)")

  const marker = `smoke-${Date.now()}`
  const send = await rpc("message_send", { session_id: "smoke-session", content: marker }, jwt)
  check(send.status === 200, `message_send → 200 (got ${send.status})`)
  const read = await rpc("message_get_by_session", { session_id: "smoke-session" }, jwt)
  check(
    read.body?.rows?.some((row) => row.content === marker),
    "message_send round-trips through the brain's Dexie"
  )
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

  // Watch /ws/v1/events for sidecar frames on our session.
  const sawEvent = await new Promise((resolve) => {
    const ws = new WebSocket(
      `${SERVER_URL.replace(/^http/, "ws")}/ws/v1/events?token=${encodeURIComponent(jwt)}`
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
  const res = await fetch(`${SERVER_URL}/connectors/webhook/telegram/ghost`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
  check(res.status === 404, `unregistered webhook adapter → 404 (got ${res.status})`)
  const body = await res.json().catch(() => null)
  check(body?.error === "adapter not registered", "webhook rejection shape is deterministic")
}

/** Device JWT from tier 2, reused by tier 3's proxied-WS assertion. */
let tier2Jwt = null

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
  check(ready.brain.ready === true, "brain completed the bridge hello")
  check(typeof ready.sidecar?.restart_count === "number", "healthz reports the sidecar block")

  const jwt = await pairDevice()
  if (!jwt) {
    fatal("pairing failed — cannot continue tier 2")
  }
  tier2Jwt = jwt
  await dataPlaneRoundtrip(jwt)
  await chatTurn(jwt)
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
  const health = await fetch(`${CADDY_URL}/api/v1/healthz`)
  check(health.ok, `GET ${CADDY_URL}/api/v1/healthz → 200 (got ${health.status})`)

  // 3. WebSocket upgrade proxies natively.
  if (!tier2Jwt) {
    skip("no device JWT from tier 2 — proxied WS upgrade not exercised")
    return
  }
  const wsUp = await new Promise((resolve) => {
    const ws = new WebSocket(
      `${CADDY_URL.replace(/^http/, "ws")}/ws/v1/events?token=${encodeURIComponent(tier2Jwt)}`
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
  check(wsUp, "/ws/v1/events upgrades through the Caddy proxy")
}

// ---------------------------------------------------------------------------

async function main() {
  const tier = parseTier()
  await tierServices()
  if (tier === "server" || tier === "tls") await tierServer()
  if (tier === "tls") await tierTls()

  if (failures > 0) fatal(`${failures} check(s) failed`)
  log("OK — all checks passed")
}

main().catch((err) => {
  console.error("[smoke] FAIL (uncaught):", err)
  process.exit(1)
})
