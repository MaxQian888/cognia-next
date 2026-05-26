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

function connect(role) {
  const ws = new WebSocket(`${BASE}/v1/signaling?rid=${RID}`)
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

function send(ws, frame) {
  ws.send(JSON.stringify(frame))
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

  desktop.close()
  mobile.close()
  console.log("✓ signaling worker integration smoke passed")
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("✗", err.message)
    process.exit(1)
  }
)
