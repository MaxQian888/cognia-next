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
 */

import process from "node:process"
import { setTimeout as delay } from "node:timers/promises"

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
  const ws = new WebSocket(`${SIGNALING_URL.replace(/^http/, "ws")}/v1/signaling`)
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

async function signalingRelay() {
  const a = signalingWs("A")
  const b = signalingWs("B")
  await a.open()
  await b.open()
  const sub = (role) => ({ kind: "subscribe", rendezvousId: "smoke", role, clientNonce: role })
  a.send(sub("desktop"))
  const aSubbed = await a.next()
  check(aSubbed?.kind === "subscribed", "A subscribed")
  b.send(sub("mobile"))
  await b.next()
  const payload = Buffer.from(JSON.stringify({ hi: 1 })).toString("base64url")
  b.send({ kind: "relay", rendezvousId: "smoke", payload })
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
// Tier 2 (server) and Tier 3 (tls) land with ADR-0059 D6 / D7.
// ---------------------------------------------------------------------------

async function tierServer() {
  skip("tier 'server' assertions land with ADR-0059 W6 (D6) — pair → chat → agent → webhook")
}

async function tierTls() {
  skip("tier 'tls' assertions land with ADR-0059 F2 (D7) — Caddy chain + WS upgrade")
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
