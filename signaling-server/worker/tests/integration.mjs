// End-to-end smoke test for the Cloudflare Worker signaling rendezvous.
//
// Drives a running Worker (local `wrangler dev`, or a deployed URL) with two
// real WebSocket clients and asserts the relay contract the axum server and
// the TS/Rust clients depend on. Uses Node's global `WebSocket` (Node 22+),
// so it needs no dependencies.
//
//   Terminal 1:  cd signaling-server/worker && wrangler dev
//   Terminal 2:  node signaling-server/worker/tests/integration.mjs
//
// Override the base URL with SIGNALING_URL (default ws://127.0.0.1:8787).

const BASE = process.env.SIGNALING_URL ?? "ws://127.0.0.1:8787"
const RID = `it-${Date.now()}`
const TIMEOUT_MS = 5000

function connect(role, rid = RID) {
  const ws = new WebSocket(`${BASE}/v1/signaling?rid=${rid}`)
  ws._inbox = []
  ws._waiters = []
  ws.addEventListener("message", (ev) => {
    const frame = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString())
    const waiter = ws._waiters.shift()
    if (waiter) waiter(frame)
    else ws._inbox.push(frame)
  })
  ws._role = role
  return ws
}

function nextFrame(ws) {
  if (ws._inbox.length) return Promise.resolve(ws._inbox.shift())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${ws._role}: timed out waiting for a frame`)),
      TIMEOUT_MS
    )
    ws._waiters.push((frame) => {
      clearTimeout(timer)
      resolve(frame)
    })
  })
}

function open(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${ws._role}: connection did not open`)),
      TIMEOUT_MS
    )
    ws.addEventListener("open", () => {
      clearTimeout(timer)
      resolve()
    })
    ws.addEventListener("error", (e) =>
      reject(new Error(`${ws._role}: ${e.message ?? "ws error"}`))
    )
  })
}

// Like open() but resolves {ok} instead of throwing — used where an upgrade
// rejection (e.g. the per-IP cap returning 429) is an acceptable outcome.
function tryOpen(ws, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), ms)
    ws.addEventListener("open", () => {
      clearTimeout(timer)
      resolve({ ok: true })
    })
    ws.addEventListener("error", () => {
      clearTimeout(timer)
      resolve({ ok: false, reason: "upgrade-rejected" })
    })
  })
}

function send(ws, frame) {
  ws.send(JSON.stringify(frame))
}

// Resolve if NO frame arrives within `ms`; reject if one does. Used to prove
// an unsubscribed observer receives nothing.
function expectNoFrame(ws, ms) {
  return new Promise((resolve, reject) => {
    if (ws._inbox.length) {
      reject(new Error(`${ws._role}: unexpected buffered frame ${JSON.stringify(ws._inbox[0])}`))
      return
    }
    // The pushed function and the one removed on timeout must be the SAME
    // reference, or a stale waiter lingers and eats the next real frame.
    const waiter = (frame) =>
      reject(new Error(`${ws._role}: unexpected frame ${JSON.stringify(frame)}`))
    setTimeout(() => {
      const i = ws._waiters.indexOf(waiter)
      if (i >= 0) ws._waiters.splice(i, 1)
      resolve()
    }, ms)
    ws._waiters.push(waiter)
  })
}

// Subscribe and await the `subscribed` ack.
async function subscribe(ws, rid, role, nonce) {
  send(ws, { kind: "subscribe", rendezvousId: rid, role, clientNonce: nonce })
  const frame = await nextFrame(ws)
  return frame
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

async function main() {
  const desktop = connect("desktop")
  await open(desktop)
  send(desktop, { kind: "subscribe", rendezvousId: RID, role: "desktop", clientNonce: "n-d" })
  const dSub = await nextFrame(desktop)
  assert(dSub.kind === "subscribed", `desktop expected subscribed, got ${dSub.kind}`)
  assert(Array.isArray(dSub.peers) && dSub.peers.length === 0, "desktop joins an empty room")

  const mobile = connect("mobile")
  await open(mobile)
  send(mobile, { kind: "subscribe", rendezvousId: RID, role: "mobile", clientNonce: "n-m" })
  const mSub = await nextFrame(mobile)
  assert(mSub.kind === "subscribed", `mobile expected subscribed, got ${mSub.kind}`)
  assert(
    mSub.peers.some((p) => p.role === "desktop"),
    "mobile sees the desktop peer in its snapshot"
  )

  const joined = await nextFrame(desktop)
  assert(
    joined.kind === "peerJoined" && joined.role === "mobile",
    "desktop is notified of the mobile peer"
  )

  // Duplicate Subscribe for the same room/socket is idempotent. It must not
  // produce a second subscribed ack, role change, or peerJoined notification.
  send(mobile, { kind: "subscribe", rendezvousId: RID, role: "mobile", clientNonce: "n-m2" })
  await expectNoFrame(mobile, 300)
  await expectNoFrame(desktop, 300)

  // Relay round-trip: payload is opaque, forwarded verbatim.
  send(mobile, { kind: "relay", rendezvousId: RID, payload: "AAAA" })
  const relayed = await nextFrame(desktop)
  assert(
    relayed.kind === "relay" && relayed.fromRole === "mobile" && relayed.payload === "AAAA",
    "relay forwarded verbatim"
  )

  // 8 KiB soft cap.
  send(mobile, { kind: "relay", rendezvousId: RID, payload: "x".repeat(9 * 1024) })
  const tooLarge = await nextFrame(mobile)
  assert(
    tooLarge.kind === "error" && tooLarge.code === "frame_too_large",
    "oversized frame is rejected gracefully"
  )

  // Ping/pong (auto-response).
  send(mobile, { kind: "ping" })
  const pong = await nextFrame(mobile)
  assert(pong.kind === "pong", "ping is answered with pong")

  // Subscribed-only fan-out (the security fix): an observer that connects but
  // never subscribes must NOT receive relayed envelopes, and must not trip a
  // peerJoined to the subscribed peers.
  const observer = connect("observer")
  await open(observer)
  await expectNoFrame(desktop, 300) // no peerJoined for an unsubscribed socket
  send(mobile, { kind: "relay", rendezvousId: RID, payload: "BBBB" })
  const relayed2 = await nextFrame(desktop)
  assert(
    relayed2.kind === "relay" && relayed2.payload === "BBBB",
    "relay still reaches the desktop"
  )
  await expectNoFrame(observer, 300) // observer eavesdrops nothing
  observer.close()

  // The Durable Object is selected by ?rid= at upgrade time. A later frame
  // claiming a different rendezvousId is a protocol violation and must not
  // appear as a peer in the actor's real room.
  const mismatch = connect("mismatch", RID)
  await open(mismatch)
  send(mismatch, {
    kind: "subscribe",
    rendezvousId: `${RID}-wrong`,
    role: "mobile",
    clientNonce: "n-mm",
  })
  const mmSub = await nextFrame(mismatch)
  assert(
    mmSub.kind === "error" && mmSub.code === "room_mismatch",
    "mismatched subscribe is rejected"
  )
  await expectNoFrame(desktop, 300)
  send(mismatch, { kind: "relay", rendezvousId: `${RID}-wrong`, payload: "CCCC" })
  const mmRelay = await nextFrame(mismatch)
  assert(
    mmRelay.kind === "error" && mmRelay.code === "room_mismatch",
    "mismatched relay is rejected"
  )
  await expectNoFrame(desktop, 300)
  mismatch.close()

  // Malformed JSON uses the same stable error code as the axum backend.
  mobile.send("not-json")
  const malformed = await nextFrame(mobile)
  assert(
    malformed.kind === "error" && malformed.code === "malformed_frame",
    "malformed frame is rejected with malformed_frame"
  )

  // Binary frames are explicitly rejected (parity with the axum server).
  mobile.send(new Uint8Array([1, 2, 3]))
  const bin = await nextFrame(mobile)
  assert(
    bin.kind === "error" && bin.code === "binary_not_supported",
    "binary frame is rejected with binary_not_supported"
  )

  desktop.close()
  mobile.close()

  // Role cardinality: a second desktop into a fresh room is role_taken.
  const ridA = `${RID}-roles`
  const d1 = connect("desktop", ridA)
  await open(d1)
  const s1 = await subscribe(d1, ridA, "desktop", "n-d1")
  assert(s1.kind === "subscribed", "first desktop subscribes")
  const d2 = connect("desktop2", ridA)
  await open(d2)
  const s2 = await subscribe(d2, ridA, "desktop", "n-d2")
  assert(s2.kind === "error" && s2.code === "role_taken", "second desktop is role_taken")
  d1.close()
  d2.close()

  // Room cap: with the default cap of 4, the 5th subscriber is room_full.
  const ridB = `${RID}-cap`
  const cap = []
  const capDesktop = connect("desktop", ridB)
  await open(capDesktop)
  await subscribe(capDesktop, ridB, "desktop", "c-d")
  cap.push(capDesktop)
  for (let i = 0; i < 3; i++) {
    const m = connect(`mobile${i}`, ridB)
    await open(m)
    const s = await subscribe(m, ridB, "mobile", `c-m${i}`)
    assert(s.kind === "subscribed", `mobile ${i} fills a room slot`)
    cap.push(m)
  }
  // The 5th is rejected one of two ways depending on environment: against a
  // real Cloudflare edge (cf-connecting-ip present) the per-IP cap (default 4,
  // = room cap) refuses the UPGRADE first since all 5 share one IP; locally
  // (no cf-connecting-ip) per-IP is a no-op so the 5th subscribes and gets a
  // `room_full` error frame. Accept either — both prove the room is bounded.
  const overflow = connect("overflow", ridB)
  const opened = await tryOpen(overflow, TIMEOUT_MS)
  if (!opened.ok) {
    console.log("  5th connection refused at upgrade (per-IP cap) ✓")
  } else {
    const ofRes = await subscribe(overflow, ridB, "mobile", "c-of")
    assert(ofRes.kind === "error" && ofRes.code === "room_full", "5th subscriber is room_full")
    console.log("  5th subscribe refused (room_full) ✓")
  }
  overflow.close()
  for (const ws of cap) ws.close()

  console.log("✓ signaling worker integration smoke passed")
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("✗", err.message)
    process.exit(1)
  }
)
