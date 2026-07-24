#!/usr/bin/env node
/**
 * Real-pair WebRTC smoke (`pnpm webrtc:pair`). ADR-0021.
 *
 * The unit tests mock `RTCPeerConnection`; `pnpm webrtc:smoke` only exercises
 * the signaling SERVER's transport layer. Neither opens a real DataChannel.
 * This driver does: it stands up the full triangle and runs the SDP/ICE/DTLS/
 * SCTP handshake for real, across the TS↔Rust language boundary.
 *
 *   ┌─────────────────────┐   real WSS    ┌──────────────────────┐
 *   │  Chromium (offerer) │◄─────────────►│ cognia-signaling-    │
 *   │  real TransportRtc  │   relay only  │ server (real)        │
 *   │  real RTCPeerConn.  │               └──────────┬───────────┘
 *   └──────────┬──────────┘                          │ real WSS
 *              │  real DTLS/SCTP DataChannel          │
 *              └─────────────────────────────────────┘
 *                          ▲
 *              ┌───────────┴────────────┐
 *              │ cognia-webrtc-peer     │  real webrtc-rs answerer
 *              │ (real signaling client,│  + real envelope sign/verify
 *              │  peer, dispatch)       │  + real EventBus bridge
 *              └────────────────────────┘
 *
 * Scenarios (each on real transport):
 *   P1  cold start, desktop already in room     → open, host candidate
 *   P2  cold-start RACE, mobile subscribes first → completes when desktop joins
 *       (regression guard for ADR-0021 F1 — pre-fix this would 8s-timeout)
 *   P3  RPC round-trip                          → structured response frame
 *   P4  event delivery                          → subscribe() fires, seq mono
 *   P5  mid-session disconnect                  → open→reconnecting→open
 *   P6  reconnectNow() during negotiation       → "busy", not a false "started"
 *       (regression guard for ADR-0021 F3)
 *   P7  graceful close                          → rtc:close observed
 *
 * Requires the E2E static export (`pnpm test:e2e:build`) so the browser bundle
 * carries the `__cogniaE2EWebRtc` seam. Exit 0 on success, 1 otherwise.
 */

import { spawn, spawnSync } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { randomUUID, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import path from "node:path"
import process from "node:process"

import { chromium } from "@playwright/test"

import { createOutServer, exportHasE2eMarker } from "../e2e/serve-out.mjs"

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..")
const SIGNALING_DIR = path.join(REPO, "services", "signaling-server")
const PROFILE = process.env.WEBRTC_PAIR_PROFILE ?? "debug"
// The src-tauri crate is part of the ROOT cargo workspace, so its binaries
// land in <repo>/target/, NOT src-tauri/target/ (the signaling server below is
// a SEPARATE workspace with its own target/).
const HARNESS_BIN = path.join(
  REPO,
  "target",
  PROFILE,
  `cognia-webrtc-peer${process.platform === "win32" ? ".exe" : ""}`
)
const SIGNALING_BIN = path.join(
  SIGNALING_DIR,
  "target",
  PROFILE,
  `cognia-signaling-server${process.platform === "win32" ? ".exe" : ""}`
)
const OUT_ROOT = path.join(REPO, "out")

function log(...args) {
  console.log("[pair]", ...args)
}
function fatal(msg) {
  throw new Error(msg)
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function cargoBuild(cwd, args, label) {
  log(`building ${label}…`)
  const res = spawnSync("cargo", ["build", ...args], {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  })
  if (res.status !== 0) fatal(`cargo build (${label}) exited ${res.status}`)
}

function ensureBinaries() {
  if (process.env.WEBRTC_PAIR_SKIP_BUILD === "1") {
    log("skipping cargo build (WEBRTC_PAIR_SKIP_BUILD=1)")
  } else {
    const profileArgs = PROFILE === "release" ? ["--release"] : []
    cargoBuild(SIGNALING_DIR, profileArgs, "signaling-server")
    cargoBuild(
      path.join(REPO, "src-tauri"),
      [...profileArgs, "--features", "webrtc-harness", "--bin", "cognia-webrtc-peer"],
      "cognia-webrtc-peer"
    )
  }
  if (!existsSync(SIGNALING_BIN)) fatal(`signaling server binary not found: ${SIGNALING_BIN}`)
  if (!existsSync(HARNESS_BIN)) fatal(`harness binary not found: ${HARNESS_BIN}`)
}

function ensureExport() {
  if (!existsSync(path.join(OUT_ROOT, "index.html"))) {
    fatal(`static export missing at ${OUT_ROOT} — run \`pnpm test:e2e:build\` first`)
  }
  if (!exportHasE2eMarker(OUT_ROOT)) {
    fatal(
      "static export was built WITHOUT NEXT_PUBLIC_E2E=1 — the __cogniaE2EWebRtc seam is absent; run `pnpm test:e2e:build`"
    )
  }
}

// ---------------------------------------------------------------------------
// Signaling server
// ---------------------------------------------------------------------------

async function bootSignaling() {
  const child = spawn(SIGNALING_BIN, ["--bind", "127.0.0.1:0"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RUST_LOG: "info", NO_COLOR: "1" },
  })
  const port = await new Promise((resolve, reject) => {
    let buffered = ""
    const timeout = setTimeout(
      () => reject(new Error(`signaling server did not announce a port in 10s:\n${buffered}`)),
      10_000
    )
    const onChunk = (chunk) => {
      buffered += chunk.toString().replace(/\x1b\[[0-9;]*m/g, "")
      const m = buffered.match(/bound=127\.0\.0\.1:(\d+)/)
      if (m) {
        clearTimeout(timeout)
        child.stdout.removeListener("data", onChunk)
        resolve(Number(m[1]))
      }
    }
    child.stdout.on("data", onChunk)
    child.stderr.on("data", () => undefined)
    child.on("exit", (code) => {
      clearTimeout(timeout)
      reject(new Error(`signaling server exited early with code ${code}`))
    })
  })
  child.stdout.on("data", () => undefined)
  return { child, port }
}

// ---------------------------------------------------------------------------
// Harness desktop peer
// ---------------------------------------------------------------------------

/**
 * Start the Rust answerer. Returns a controller that parses the JSON stdout
 * protocol so scenarios can await a tier, push an event, or stop it.
 */
function startHarnessPeer({ signalingUrl, rid, secret, deviceId }) {
  const child = spawn(
    HARNESS_BIN,
    ["--signaling", signalingUrl, "--rid", rid, "--secret", secret, "--device-id", deviceId],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, COGNIA_LOG: process.env.COGNIA_LOG ?? "info" },
    }
  )
  const tiers = []
  const waiters = []
  let buffer = ""
  const emit = (obj) => {
    if (obj.kind === "tier") tiers.push(obj.tier)
    for (const w of waiters.slice()) {
      if (w.predicate(obj)) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(obj)
      }
    }
  }
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString()
    let nl
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      try {
        emit(JSON.parse(line))
      } catch {
        // non-JSON log noise — ignore
      }
    }
  })
  child.stderr.on("data", (c) => {
    if (process.env.WEBRTC_PAIR_DEBUG === "1") process.stderr.write(`[peer] ${c}`)
  })

  return {
    child,
    tiers,
    /** Resolve once a protocol object matching `predicate` is emitted. */
    waitFor(predicate, timeoutMs = 15_000, label = "event") {
      return Promise.race([
        new Promise((resolve) => waiters.push({ predicate, resolve })),
        delay(timeoutMs).then(() => {
          throw new Error(`harness peer: timed out waiting for ${label}`)
        }),
      ])
    },
    waitForTier(tier, timeoutMs = 15_000) {
      if (tiers.includes(tier)) return Promise.resolve({ kind: "tier", tier })
      return this.waitFor((o) => o.kind === "tier" && o.tier === tier, timeoutMs, `tier=${tier}`)
    },
    emitEvent(event, payload) {
      child.stdin.write(`emit-event ${event} ${JSON.stringify(payload)}\n`)
    },
    stop() {
      try {
        child.stdin.write("quit\n")
      } catch {
        // ignored
      }
      child.kill()
    },
  }
}

// ---------------------------------------------------------------------------
// Browser side (real TransportRtc via the __cogniaE2EWebRtc seam)
// ---------------------------------------------------------------------------

function makeBrowserApi(page) {
  return {
    connect: (opts) => page.evaluate((o) => window.__cogniaE2EWebRtc.connect(o), opts),
    connectNoWait: (opts) =>
      // Kick off connect() but DON'T await it — used by P2/P6 to observe an
      // in-flight state. Returns immediately.
      page.evaluate((o) => {
        window.__cogniaE2EWebRtc.connect(o).catch(() => undefined)
      }, opts),
    getState: () => page.evaluate(() => window.__cogniaE2EWebRtc.getState()),
    candidateKind: () => page.evaluate(() => window.__cogniaE2EWebRtc.getSelectedCandidateKind()),
    call: (method, params) =>
      page.evaluate(([m, p]) => window.__cogniaE2EWebRtc.call(m, p), [method, params]),
    subscribe: (event) => page.evaluate((e) => window.__cogniaE2EWebRtc.subscribe(e), event),
    events: (event) => page.evaluate((e) => window.__cogniaE2EWebRtcEvents[e] ?? [], event),
    reconnectNow: () => page.evaluate(() => window.__cogniaE2EWebRtc.reconnectNow()),
    close: () => page.evaluate(() => window.__cogniaE2EWebRtc.close()),
  }
}

async function waitForBrowserState(api, target, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let last = ""
  while (Date.now() < deadline) {
    last = await api.getState()
    if (last === target) return
    await delay(100)
  }
  throw new Error(`browser: timed out waiting for state ${target}; last=${last}`)
}

async function waitForAnyBrowserState(api, targets, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let last = ""
  while (Date.now() < deadline) {
    last = await api.getState()
    if (targets.includes(last)) return last
    await delay(50)
  }
  throw new Error(`browser: timed out waiting for one of ${targets}; last=${last}`)
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function freshRoom() {
  return {
    rid: randomUUID(),
    secret: randomBytes(32).toString("base64url"),
    deviceId: `dev-${randomBytes(4).toString("hex")}`,
  }
}

async function run() {
  ensureBinaries()
  ensureExport()

  const { child: sigChild, port } = await bootSignaling()
  const signalingUrl = `ws://127.0.0.1:${port}/v1/signaling`
  log(`signaling server on ${signalingUrl}`)

  const outServer = createOutServer(OUT_ROOT)
  const httpPort = await new Promise((resolve) =>
    outServer.listen(0, "127.0.0.1", () => resolve(outServer.address().port))
  )
  const pageUrl = `http://127.0.0.1:${httpPort}/`
  log(`static export on ${pageUrl}`)

  const browser = await chromium.launch({ args: ["--no-sandbox"] })
  const cleanupFns = [
    () => browser.close(),
    () =>
      new Promise((r) => {
        outServer.close(() => r())
      }),
    () => sigChild.kill(),
  ]
  let peer = null

  try {
    const page = await browser.newPage()
    await page.goto(pageUrl)
    await page.waitForFunction(() => window.__cogniaTestGlobalsReady === true, { timeout: 30_000 })
    const api = makeBrowserApi(page)

    // ── P1 — cold start, desktop already present ────────────────────────────
    {
      log("P1: cold start (desktop already in room)")
      const room = freshRoom()
      peer = startHarnessPeer({ signalingUrl, ...room })
      await peer.waitForTier("awaiting") // desktop subscribed, room ready
      await api.connect({
        signalingUrl,
        rendezvousId: room.rid,
        rendezvousSecret: room.secret,
        deviceId: "mobile-p1",
        peerWaitTimeoutMs: 15_000,
        negotiationTimeoutMs: 15_000,
      })
      await waitForBrowserState(api, "open")
      await peer.waitForTier("connected")
      const kind = await api.candidateKind()
      if (!["host", "srflx", "prflx"].includes(kind)) {
        fatal(`P1: expected a direct candidate, got ${kind}`)
      }
      log(`P1 OK — open, candidate=${kind}`)

      // ── P3 — RPC round-trip (reuse the open P1 channel) ───────────────────
      log("P3: RPC round-trip")
      // No dispatch host in the harness → structured service_unavailable frame.
      let rpcResult
      try {
        rpcResult = await api.call("session_list", {})
        fatal(
          `P3: expected the harness to reject with service_unavailable, got ${JSON.stringify(rpcResult)}`
        )
      } catch (err) {
        const msg = String(err)
        if (!/service_unavailable|app_handle not available/.test(msg)) {
          fatal(`P3: expected service_unavailable error, got ${msg}`)
        }
      }
      log("P3 OK — inbound RPC answered with the documented service_unavailable frame")

      // ── P4 — event delivery (desktop → browser) ───────────────────────────
      log("P4: event delivery + seq monotonicity")
      await api.subscribe("harness://tick")
      peer.emitEvent("harness://tick", { n: 1 })
      peer.emitEvent("harness://tick", { n: 2 })
      const deadline = Date.now() + 10_000
      let received = []
      while (Date.now() < deadline) {
        received = await api.events("harness://tick")
        if (received.length >= 2) break
        await delay(100)
      }
      if (received.length < 2) fatal(`P4: expected ≥2 events, got ${received.length}`)
      const seqs = received.map((e) => e.seq)
      for (let i = 1; i < seqs.length; i++) {
        if (seqs[i] <= seqs[i - 1]) fatal(`P4: seq not monotonic: ${seqs}`)
      }
      log(`P4 OK — ${received.length} events, seqs=${seqs}`)

      // ── P5 — mid-session disconnect + auto-reconnect ──────────────────────
      log("P5: mid-session disconnect → reconnect")
      peer.stop()
      await waitForAnyBrowserState(api, ["reconnecting", "awaiting-peer", "failed"], 15_000)
      // Bring the desktop back; the TS backoff schedule re-handshakes.
      peer = startHarnessPeer({ signalingUrl, ...room })
      await waitForBrowserState(api, "open", 30_000)
      log("P5 OK — recovered to open after the peer restarted")

      // ── P7 — graceful close ───────────────────────────────────────────────
      log("P7: graceful close")
      await api.close()
      // The harness peer sees the room empty (peerLeft) and drops back to
      // awaiting; that transition proves it observed our teardown.
      await peer.waitForTier("awaiting", 10_000)
      log("P7 OK — peer observed teardown")
      peer.stop()
      peer = null
    }

    // ── P2 — cold-start RACE (mobile subscribes first) ──────────────────────
    {
      log("P2: cold-start race (mobile subscribes before desktop) — F1 regression guard")
      const room = freshRoom()
      // Browser connects into an EMPTY room. Pre-F1 it would fire an offer the
      // server drops, then 8s-timeout. Post-F1 it must hold in awaiting-peer.
      await api.connectNoWait({
        signalingUrl,
        rendezvousId: room.rid,
        rendezvousSecret: room.secret,
        deviceId: "mobile-p2",
        peerWaitTimeoutMs: 25_000,
        negotiationTimeoutMs: 8_000,
      })
      await waitForBrowserState(api, "awaiting-peer", 10_000)
      // Give it a beat well past the 8s negotiation timeout to prove it does
      // NOT fail (the bug's signature).
      await delay(8_500)
      const stillWaiting = await api.getState()
      if (stillWaiting !== "awaiting-peer") {
        fatal(`P2: expected to hold in awaiting-peer, got ${stillWaiting}`)
      }
      // Now the desktop joins → handshake completes.
      peer = startHarnessPeer({ signalingUrl, ...room })
      await waitForBrowserState(api, "open", 30_000)
      await peer.waitForTier("connected")
      log("P2 OK — mobile-first cold start completed once the desktop joined")
    }

    // ── P6 — reconnectNow() during negotiation returns 'busy' (F3) ───────────
    {
      log("P6: reconnectNow() during in-flight negotiation — F3 regression guard")
      // From the open P2 channel, force a fresh handshake and immediately
      // (while it's re-negotiating) call reconnectNow again.
      const first = await api.reconnectNow()
      if (first !== "started") fatal(`P6: first reconnectNow expected 'started', got ${first}`)
      // Poll for an in-flight state, then assert a second call is 'busy'.
      const inflight = await waitForAnyBrowserState(
        api,
        ["signaling-connecting", "awaiting-peer", "negotiating"],
        10_000
      )
      const second = await api.reconnectNow()
      if (second !== "busy") {
        fatal(
          `P6: reconnectNow during ${inflight} expected 'busy' (not a false success), got ${second}`
        )
      }
      log(`P6 OK — reconnectNow during ${inflight} returned 'busy'`)
      await api.close()
      peer?.stop()
      peer = null
    }

    log("OK — all scenarios passed")
  } catch (err) {
    console.error("[pair] FAIL:", err)
    process.exitCode = 1
  } finally {
    peer?.stop()
    for (const fn of cleanupFns) {
      try {
        await fn()
      } catch {
        // ignored
      }
    }
    await delay(50)
  }
}

run().catch((err) => {
  console.error("[pair] FAIL (uncaught):", err)
  process.exit(1)
})
