#!/usr/bin/env node
/**
 * Smoke test for the standalone signaling rendezvous server.
 *
 * Boots `services/signaling-server/target/<profile>/cognia-signaling-server` on an
 * ephemeral port, drives two WebSocket clients through the supported
 * lifecycle (subscribe → relay → unsubscribe), and asserts the server's
 * rejection paths:
 *
 *   1. Two clients in the same room: A relays → B receives the same
 *      payload with `fromRole=A.role`.
 *   2. Relay without a prior subscribe → `Error{code: "not_subscribed"}`.
 *   3. Malformed JSON frame → `Error{code: "malformed_frame"}`.
 *   4. Rate-limit kicks in at the 21st frame in <1 s (token-bucket cap
 *      = 20, refill = 10/s) → `Error{code: "rate_limited"}` and the
 *      socket closes.
 *   5. `/healthz` returns `{ ok: true, rooms, peers, uptimeSeconds }`.
 *   6. `/metrics` returns Prometheus text exposition.
 *
 * Relay decryption is intentionally not covered here — the rendezvous is
 * opaque to ciphertext. This smoke does cover the v2 challenge and signed
 * role admission enforced by the server.
 *
 * Exit code is `0` on success, `1` otherwise. Designed to slot into
 * `pnpm webrtc:smoke` (added in W7) and CI.
 */

import { spawn, spawnSync } from "node:child_process"
import { randomBytes, webcrypto } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import process from "node:process"

// `WebSocket` and `fetch` are globals in Node >= 22 (and 21 with flag).
// The smoke runs in CI under Node 22, so we don't depend on undici imports.
if (typeof globalThis.WebSocket !== "function") {
  console.error("[smoke] FAIL: globalThis.WebSocket is undefined — this script requires Node 22+")
  process.exit(1)
}

const PROFILE = process.env.SIGNALING_SMOKE_PROFILE ?? "debug"
const BIN_PATH =
  process.env.SIGNALING_SMOKE_BIN ??
  `services/signaling-server/target/${PROFILE}/cognia-signaling-server${process.platform === "win32" ? ".exe" : ""}`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(...args) {
  console.log("[smoke]", ...args)
}

function fatal(msg) {
  console.error("[smoke] FAIL:", msg)
  process.exit(1)
}

function ensureBuilt() {
  const result = spawnSync(
    "cargo",
    ["build", PROFILE === "release" ? "--release" : ""].filter(Boolean),
    {
      cwd: "services/signaling-server",
      stdio: "inherit",
      shell: process.platform === "win32",
    }
  )
  if (result.status !== 0) {
    fatal(`cargo build exited ${result.status}`)
  }
}

async function bootServer() {
  const child = spawn(BIN_PATH, ["--bind", "127.0.0.1:0"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RUST_LOG: "info", NO_COLOR: "1" },
  })
  // `tracing_subscriber::fmt()` writes to stdout by default, so the
  // "listening bound=..." log lands on child.stdout — not stderr.
  const port = await new Promise((resolve, reject) => {
    let buffered = ""
    const timeout = setTimeout(() => {
      reject(
        new Error(`server did not announce a bound port within 10s. stdout so far:\n${buffered}`)
      )
    }, 10_000)
    const onChunk = (chunk) => {
      buffered += chunk.toString()
      // Strip ANSI just in case (NO_COLOR should suppress, but be defensive).
      const stripped = buffered.replace(/\x1b\[[0-9;]*m/g, "")
      const m = stripped.match(/bound=127\.0\.0\.1:(\d+)/)
      if (m) {
        clearTimeout(timeout)
        child.stdout.removeListener("data", onChunk)
        resolve(Number(m[1]))
      }
    }
    child.stdout.on("data", onChunk)
    child.stderr.on("data", () => undefined)
    child.on("error", (err) => {
      clearTimeout(timeout)
      reject(err)
    })
    child.on("exit", (code) => {
      clearTimeout(timeout)
      reject(new Error(`server exited prematurely with code ${code}`))
    })
  })
  // Keep draining the pipes so a long-running smoke doesn't block on a
  // full buffer.
  child.stdout.on("data", () => undefined)
  return { child, port }
}

function connect(port, label) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/signaling`)
  const inbox = []
  const waiters = []
  const drainWaiters = () => {
    while (waiters.length > 0 && inbox.length > 0) {
      waiters.shift()(inbox.shift())
    }
  }
  ws.addEventListener("message", (event) => {
    let frame
    try {
      frame = JSON.parse(event.data.toString())
    } catch {
      frame = { type: "raw", raw: event.data.toString() }
    }
    inbox.push(frame)
    drainWaiters()
  })
  // Resolve any pending readers with `null` on close so the smoke doesn't
  // hang past the test timeout when the server tears down the connection
  // after a rate-limit hit (the rate_limited frame might race the close).
  ws.addEventListener("close", () => {
    while (waiters.length > 0) {
      waiters.shift()(null)
    }
  })
  return {
    label,
    ws,
    async open() {
      if (ws.readyState === WebSocket.OPEN) return
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true })
        ws.addEventListener(
          "error",
          (e) => reject(new Error(`ws[${label}] error: ${e.message ?? e}`)),
          {
            once: true,
          }
        )
      })
    },
    send(frame) {
      ws.send(JSON.stringify(frame))
    },
    sendRaw(text) {
      ws.send(text)
    },
    async next(timeoutMs = 1_000) {
      if (inbox.length > 0) return inbox.shift()
      return Promise.race([
        new Promise((resolve) => waiters.push(resolve)),
        delay(timeoutMs).then(() => null),
      ])
    },
    close() {
      try {
        ws.close()
      } catch {
        // ignored
      }
    },
  }
}

async function expectFrame(client, predicate, timeoutMs = 1_000, label = "frame") {
  const frame = await client.next(timeoutMs)
  if (!frame) fatal(`${client.label}: timed out waiting for ${label}`)
  if (!predicate(frame))
    fatal(`${client.label}: unexpected frame ${JSON.stringify(frame)} (waiting for ${label})`)
  return frame
}

async function fetchJson(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  if (!res.ok) fatal(`GET ${path} → ${res.status}`)
  return res.json()
}

async function fetchText(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  if (!res.ok) fatal(`GET ${path} → ${res.status}`)
  return res.text()
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function encodeFields(fields) {
  const parts = []
  for (const value of fields) {
    const field = Buffer.from(String(value), "utf8")
    const length = Buffer.alloc(4)
    length.writeUInt32BE(field.byteLength)
    parts.push(length, field)
  }
  return Buffer.concat(parts)
}

async function signingIdentity() {
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

async function createRoom() {
  const [desktop, mobile] = await Promise.all([signingIdentity(), signingIdentity()])
  const roomNonce = randomBytes(16).toString("base64url")
  const notAfter = Date.now() + 60_000
  const digest = await webcrypto.subtle.digest(
    "SHA-256",
    encodeFields([2, roomNonce, desktop.publicKey, mobile.publicKey, notAfter])
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

async function subscribeFrame(room, role, challenge) {
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
    encodeFields([
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

async function expectChallenge(client) {
  return expectFrame(client, (frame) => frame.kind === "challenge", 1_000, "challenge")
}

async function scenarioSubscribeRelay(port) {
  log("scenario: subscribe → relay → unsubscribe")
  const a = connect(port, "A")
  const b = connect(port, "B")
  await a.open()
  await b.open()
  const [aChallenge, bChallenge] = await Promise.all([expectChallenge(a), expectChallenge(b)])
  const room = await createRoom()

  a.send(await subscribeFrame(room, "desktop", aChallenge.challenge))
  await expectFrame(
    a,
    (f) => f.kind === "subscribed" && f.rendezvousId === room.descriptor.roomId,
    1_000,
    "A.subscribed"
  )

  b.send(await subscribeFrame(room, "mobile", bChallenge.challenge))
  await expectFrame(b, (f) => f.kind === "subscribed", 1_000, "B.subscribed")
  await expectFrame(
    a,
    (f) => f.kind === "peerJoined" && f.peer?.proof?.role === "mobile",
    1_000,
    "A.peerJoined(mobile)"
  )

  // Payload is an opaque base64-encoded application envelope — for the
  // server smoke we just need a stable string so the relay is forwarded.
  const payload = JSON.stringify({ ciphertext: "opaque" })
  b.send({ kind: "relay", rendezvousId: room.descriptor.roomId, payload })
  await expectFrame(
    a,
    (f) => f.kind === "relay" && f.fromRole === "mobile" && f.payload === payload,
    1_000,
    "A.relay(from mobile)"
  )

  b.send({ kind: "unsubscribe", rendezvousId: room.descriptor.roomId })
  await expectFrame(
    a,
    (f) => f.kind === "peerLeft" && f.role === "mobile",
    1_000,
    "A.peerLeft(mobile)"
  )

  a.close()
  b.close()
}

async function scenarioRelayWithoutSubscribe(port) {
  log("scenario: relay without subscribe → not_subscribed")
  const c = connect(port, "C")
  await c.open()
  await expectChallenge(c)
  c.send({ kind: "relay", rendezvousId: "ghost", payload: "Zm9v" })
  await expectFrame(
    c,
    (f) => f.kind === "error" && f.code === "not_subscribed",
    1_000,
    "error not_subscribed"
  )
  c.close()
}

async function scenarioMalformedFrame(port) {
  log("scenario: malformed JSON → malformed_frame")
  const d = connect(port, "D")
  await d.open()
  await expectChallenge(d)
  d.sendRaw("{ this is not valid json")
  await expectFrame(
    d,
    (f) => f.kind === "error" && f.code === "malformed_frame",
    1_000,
    "error malformed_frame"
  )
  d.close()
}

async function scenarioRateLimit(port) {
  log("scenario: rate limit fires past the 20-frame burst")
  const e = connect(port, "E")
  await e.open()
  const challenge = await expectChallenge(e)
  const room = await createRoom()
  e.send(await subscribeFrame(room, "desktop", challenge.challenge))
  await expectFrame(e, (f) => f.kind === "subscribed", 1_000, "E.subscribed")
  // Track close so we can assert backpressure even when the rate_limited
  // frame races the WebSocket teardown (observed on Windows with the
  // built-in Node WebSocket — kernel discards in-flight WS frames once
  // the server-side close lands).
  let closed = false
  e.ws.addEventListener("close", () => {
    closed = true
  })
  // Burst frames in small batches with a tiny await between batches.
  // The token bucket caps at 20 with a refill of 10/s; sending a single
  // 30+ batch synchronously sometimes lost frames in the WS write buffer
  // on Windows, leaving zero responses to read. Pacing in batches of 5
  // with a microtask yield keeps the writer happy without giving the
  // bucket enough wall-time to refill.
  let sentFrames = 0
  for (let batch = 0; batch < 10; batch++) {
    for (let i = 0; i < 5; i++) {
      e.send({ kind: "ping" })
      sentFrames++
    }
    await new Promise((r) => setImmediate(r))
  }
  // Read until either rate_limited lands, the connection closes, or the
  // inbox stays dry for 1 s.
  let sawRateLimited = false
  let pongs = 0
  let other = 0
  for (let i = 0; i < sentFrames + 5; i++) {
    const f = await e.next(1_000)
    if (!f) break
    if (f.kind === "pong") {
      pongs++
      continue
    }
    if (f.kind === "error" && f.code === "rate_limited") {
      sawRateLimited = true
      break
    }
    other++
  }
  // Give the WS close handshake a moment to land so `closed` reflects
  // the server's teardown after rate-limit.
  await delay(200)
  if (!sawRateLimited && !closed) {
    fatal(
      `E observed no backpressure after ${sentFrames}-frame paced burst — neither rate_limited frame nor connection close (pongs=${pongs}, other=${other})`
    )
  }
  log(
    `  observed ${pongs} pongs before backpressure (` +
      `rate_limited=${sawRateLimited}, closed=${closed})`
  )
  e.close()
}

async function scenarioHealthAndMetrics(port) {
  log("scenario: /healthz and /metrics shape")
  const health = await fetchJson(port, "/healthz")
  if (!health || health.ok !== true) fatal(`/healthz returned ${JSON.stringify(health)}`)
  if (typeof health.uptimeSeconds !== "number") fatal(`/healthz missing uptimeSeconds`)
  if (typeof health.rooms !== "number") fatal(`/healthz missing rooms`)
  if (typeof health.peers !== "number") fatal(`/healthz missing peers`)

  const metrics = await fetchText(port, "/metrics")
  for (const fragment of [
    "signaling_frames_in_total",
    "signaling_frames_relayed_total",
    'signaling_frames_rejected_total{reason="rate"}',
    "signaling_rooms_active",
    "signaling_uptime_seconds",
  ]) {
    if (!metrics.includes(fragment)) fatal(`/metrics missing fragment: ${fragment}`)
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function main() {
  if (!process.env.SIGNALING_SMOKE_BIN) {
    ensureBuilt()
  }
  const { child, port } = await bootServer()
  let exitCode = 0
  try {
    await scenarioSubscribeRelay(port)
    await scenarioRelayWithoutSubscribe(port)
    await scenarioMalformedFrame(port)
    await scenarioRateLimit(port)
    await scenarioHealthAndMetrics(port)
    log("OK — all scenarios passed")
  } catch (err) {
    console.error("[smoke] FAIL:", err)
    exitCode = 1
  } finally {
    child.kill()
    await delay(50)
  }
  process.exit(exitCode)
}

main().catch((err) => {
  console.error("[smoke] FAIL (uncaught):", err)
  process.exit(1)
})
