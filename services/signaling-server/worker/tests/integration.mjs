// Black-box v2 conformance smoke for the Cloudflare Worker rendezvous.
// Run against `wrangler dev` or a deployed Worker via SIGNALING_URL.

import { randomBytes, webcrypto } from "node:crypto"

const BASE = process.env.SIGNALING_URL ?? "ws://127.0.0.1:8787"
const TIMEOUT_MS = 5_000

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

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

async function identity() {
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
  const [desktop, mobile] = await Promise.all([identity(), identity()])
  const roomNonce = randomBytes(16).toString("base64url")
  const notAfter = Date.now() + 60_000
  const digest = await webcrypto.subtle.digest(
    "SHA-256",
    encodeFields([2, roomNonce, desktop.publicKey, mobile.publicKey, notAfter])
  )
  return {
    descriptor: {
      v: 2,
      roomId: Buffer.from(digest).toString("base64url"),
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

function connect(label, roomId) {
  const ws = new WebSocket(`${BASE}/v2/signaling?rid=${encodeURIComponent(roomId)}`)
  const inbox = []
  const waiters = []
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data))
    const waiter = waiters.shift()
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.resolve(frame)
    } else inbox.push(frame)
  })
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: open timeout`)), TIMEOUT_MS)
    ws.addEventListener("open", () => {
      clearTimeout(timer)
      resolve()
    })
    ws.addEventListener("error", () => reject(new Error(`${label}: websocket error`)))
  })
  const closed = new Promise((resolve) => {
    ws.addEventListener("close", resolve, { once: true })
  })
  return {
    label,
    ws,
    opened,
    closed,
    send(frame) {
      ws.send(JSON.stringify(frame))
    },
    next(timeoutMs = TIMEOUT_MS) {
      if (inbox.length) return Promise.resolve(inbox.shift())
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, timer: undefined }
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error(`${label}: frame timeout`))
        }, timeoutMs)
        waiters.push(waiter)
      })
    },
    close() {
      ws.close()
    },
  }
}

async function authenticated(room, role, label) {
  const client = connect(label, room.descriptor.roomId)
  await client.opened
  const challenge = await client.next()
  assert(challenge.kind === "challenge", `${label} receives challenge`)
  const subscribe = await subscribeFrame(room, role, challenge.challenge)
  client.send(subscribe)
  const accepted = await client.next()
  assert(accepted.kind === "subscribed", `${label} authenticated subscribe`)
  return { client, subscribe, accepted }
}

async function expectNoFrame(client, timeoutMs = 250) {
  try {
    await client.next(timeoutMs)
    return false
  } catch {
    return true
  }
}

async function nextMatching(client, predicate, message, maxFrames = 4) {
  const observed = []
  for (let index = 0; index < maxFrames; index += 1) {
    const frame = await client.next()
    observed.push(frame.kind)
    if (predicate(frame)) return frame
  }
  throw new Error(`assertion failed: ${message}; observed=${observed.join(",")}`)
}

async function main() {
  const room = await createRoom()
  const desktop = await authenticated(room, "desktop", "desktop")
  assert(desktop.accepted.peers.length === 0, "desktop joins empty room")

  const mobile = await authenticated(room, "mobile", "mobile")
  assert(
    mobile.accepted.peers.some((peer) => peer.proof?.role === "desktop"),
    "mobile snapshot contains desktop proof"
  )
  const joined = await desktop.client.next()
  assert(joined.kind === "peerJoined" && joined.peer?.proof?.role === "mobile", "peerJoined")

  const payload = JSON.stringify({ ciphertext: randomBytes(48).toString("base64url") })
  mobile.client.send({ kind: "relay", rendezvousId: room.descriptor.roomId, payload })
  const relay = await desktop.client.next()
  assert(
    relay.kind === "relay" &&
      relay.fromRole === "mobile" &&
      relay.fromSessionId === mobile.subscribe.proof.sessionId &&
      relay.payload === payload,
    "opaque relay preserves authenticated sender"
  )

  // Connected-but-unauthenticated sockets cannot observe room traffic.
  const observer = connect("observer", room.descriptor.roomId)
  await observer.opened
  assert((await observer.next()).kind === "challenge", "observer receives only challenge")
  mobile.client.send({ kind: "relay", rendezvousId: room.descriptor.roomId, payload: "opaque-2" })
  assert((await desktop.client.next()).payload === "opaque-2", "desktop receives second relay")
  assert(await expectNoFrame(observer), "observer cannot eavesdrop")
  observer.close()

  // A newer valid session atomically replaces the old mobile role.
  const replacement = await authenticated(room, "mobile", "mobile-replacement")
  const replaced = await mobile.client.next()
  assert(replaced.kind === "error" && replaced.code === "session_replaced", "role takeover")
  let replacementJoined = false
  let oldSessionLeft = false
  for (let index = 0; index < 4 && (!replacementJoined || !oldSessionLeft); index += 1) {
    const frame = await desktop.client.next()
    replacementJoined ||= Boolean(
      frame.kind === "peerJoined" &&
      frame.peer?.proof?.sessionId === replacement.subscribe.proof.sessionId
    )
    oldSessionLeft ||= Boolean(
      frame.kind === "peerLeft" && frame.sessionId === mobile.subscribe.proof.sessionId
    )
  }
  assert(replacementJoined, "desktop observes replacement session join")
  assert(oldSessionLeft, "desktop observes replaced session leave")

  replacement.client.send({ kind: "ping" })
  await nextMatching(
    replacement.client,
    (frame) => frame.kind === "pong",
    "heartbeat survives hibernation API"
  )

  // Upgrade room and signed descriptor must agree.
  const mismatchUpgradeRoom = await createRoom()
  const otherRoom = await createRoom()
  const mismatch = connect("mismatch", mismatchUpgradeRoom.descriptor.roomId)
  await mismatch.opened
  const mismatchChallenge = await mismatch.next()
  mismatch.send(await subscribeFrame(otherRoom, "mobile", mismatchChallenge.challenge))
  const mismatchError = await mismatch.next()
  assert(
    mismatchError.kind === "error" && mismatchError.code === "room_mismatch",
    "room mismatch rejected"
  )
  mismatch.close()

  // Tampering with a challenge-bound proof fails role admission.
  const attackerRoom = await createRoom()
  const attacker = connect("attacker", attackerRoom.descriptor.roomId)
  await attacker.opened
  const attackerChallenge = await attacker.next()
  const bad = await subscribeFrame(attackerRoom, "mobile", attackerChallenge.challenge)
  bad.proof.epoch = "tampered-after-signing"
  attacker.send(bad)
  const authError = await attacker.next()
  assert(authError.kind === "error" && authError.code === "auth_failed", "tamper rejected")

  replacement.client.send({ kind: "unsubscribe", rendezvousId: room.descriptor.roomId })
  const left = await desktop.client.next()
  assert(
    left.kind === "peerLeft" && left.sessionId === replacement.subscribe.proof.sessionId,
    "authenticated peerLeft"
  )

  for (const client of [
    desktop.client,
    mobile.client,
    replacement.client,
    observer,
    mismatch,
    attacker,
  ]) {
    client.close()
  }
  console.log("worker signaling v2 integration: PASS")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
