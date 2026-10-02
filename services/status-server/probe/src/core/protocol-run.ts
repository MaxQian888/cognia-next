/**
 * One authenticated signaling + explicit data-lane run (plan §4).
 *
 * A run creates a throwaway room with fresh P-256 keys, joins it as desktop
 * and then as mobile (each answering its own socket's challenge), checks that
 * each side sees the other's authenticated session, relays a nonce on the
 * signal lane with an acknowledgement back (→ `signalingAuth`), then sends a
 * random ~1 KiB payload on `lane: "data"` with an exact echo back plus a
 * ping/pong (→ `relayData`). No account, invitation, user room or device key
 * is involved, and nothing bypasses the relay's normal admission.
 */

import type { CheckObservation, ReasonCode } from "../../../../../lib/status/contract"
import {
  createRoom,
  randomBase64Url,
  subscribeFrame,
  type PeerRole,
  type SubscribeFrame,
} from "../../../../signaling-server/worker/tests/synthetic-room.mjs"

import { DeadlineError, ProbeAbortedError, sleep, withDeadline } from "./deadline"
import { FrameChannel, ProbePhaseError, objectAt, type ServerFrame } from "./frames"
import {
  MAX_ROOM_RELAY_BYTES,
  ProbeTransportError,
  type ProbeLimits,
  type ProbeTransport,
} from "./types"

/** Descriptor lifetime: the run's deadline plus margin, nothing longer. */
const ROOM_TTL_MS = 120_000
const PAYLOAD_TAG = "cognia-status-probe"

const encoder = new TextEncoder()

export interface ProtocolRunInput {
  signalingUrl: string
  origin: string | null
  transport: ProbeTransport
  now: () => number
  signal: AbortSignal
  limits: ProbeLimits
}

export interface ProtocolRunOutcome {
  auth: CheckObservation
  data: CheckObservation
  aborted: boolean
  relayBytesSent: number
}

/** Tracks relay payload bytes so a room never approaches the 1 MiB budget. */
export class RelayBudget {
  sent = 0
  constructor(private readonly limit = MAX_ROOM_RELAY_BYTES) {}

  charge(payload: string): void {
    const bytes = encoder.encode(payload).byteLength
    if (this.sent + bytes >= this.limit) {
      // A programming/config error in the runner, never a target failure.
      throw new Error("relay byte budget exceeded")
    }
    this.sent += bytes
  }
}

/** `wss://host/signaling` + `?rid=<roomId>`; null for a non-WebSocket URL. */
export function signalingSocketUrl(signalingUrl: string, roomId: string): string | null {
  let url: URL
  try {
    url = new URL(signalingUrl)
  } catch {
    return null
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") return null
  url.searchParams.set("rid", roomId)
  url.hash = ""
  return url.toString()
}

interface Peer {
  role: PeerRole
  channel: FrameChannel
  subscribe: SubscribeFrame | null
  /** The relay confirmed this socket's subscription. */
  subscribed: boolean
}

type Stage = "auth" | "data"

export async function runProtocolChecks(input: ProtocolRunInput): Promise<ProtocolRunOutcome> {
  const { now, signal, limits, transport } = input
  const startedAt = now()
  const overallDeadline = startedAt + limits.protocolDeadlineMs
  const phaseDeadline = () => Math.min(now() + limits.phaseTimeoutMs, overallDeadline)
  const budget = new RelayBudget()
  const peers: Peer[] = []
  let stage: Stage = "auth"
  let authDurationMs: number | null = null
  let dataStartedAt = startedAt

  const finish = (auth: CheckObservation, data: CheckObservation, aborted = false) => ({
    auth,
    data,
    aborted,
    relayBytesSent: budget.sent,
  })

  try {
    const room = await createRoom({ now: Date.now(), ttlMs: ROOM_TTL_MS })
    const roomId = room.descriptor.roomId
    const socketUrl = signalingSocketUrl(input.signalingUrl, roomId)
    if (!socketUrl) throw new Error("signaling URL is not a WebSocket URL")

    const open = async (role: PeerRole): Promise<Peer> => {
      const remaining = phaseDeadline() - now()
      const pending = transport.openSocket(socketUrl, {
        origin: input.origin,
        timeoutMs: remaining,
        signal,
      })
      try {
        const socket = await withDeadline(pending, remaining + 50, signal)
        const peer: Peer = {
          role,
          channel: new FrameChannel(socket, now, signal),
          subscribe: null,
          subscribed: false,
        }
        peers.push(peer)
        return peer
      } catch (error) {
        // A socket that opens after we gave up must still be closed.
        pending.then((late) => late.close()).catch(() => undefined)
        throw classifyOpenError(error, input.origin, signal)
      }
    }

    const authenticate = async (peer: Peer): Promise<ServerFrame> => {
      const challenge = await peer.channel.expect(
        (frame) =>
          frame.kind === "challenge" && typeof frame.challenge === "string"
            ? frame.challenge
            : undefined,
        { deadlineAt: phaseDeadline(), timeoutReason: "auth_timeout", errorReason: "auth_rejected" }
      )
      peer.subscribe = await subscribeFrame(room, peer.role, challenge, { now: Date.now() })
      peer.channel.send(peer.subscribe as unknown as Record<string, unknown>)
      const accepted = await peer.channel.expect(
        (frame) =>
          frame.kind === "subscribed" && frame.rendezvousId === roomId ? frame : undefined,
        { deadlineAt: phaseDeadline(), timeoutReason: "auth_timeout", errorReason: "auth_rejected" }
      )
      peer.subscribed = true
      return accepted
    }

    // --- signalingAuth: both roles admitted, see each other, signal relays ---
    const desktop = await open("desktop")
    await authenticate(desktop)
    const mobile = await open("mobile")
    const mobileAccepted = await authenticate(mobile)
    const desktopProof = desktop.subscribe!.proof
    const mobileProof = mobile.subscribe!.proof

    const peersList = Array.isArray(mobileAccepted.peers) ? mobileAccepted.peers : []
    const seesDesktop = peersList.some((entry) => {
      const proof = objectAt(objectAt(entry)?.proof)
      return (
        proof?.role === "desktop" &&
        proof.sessionId === desktopProof.sessionId &&
        proof.signature === desktopProof.signature
      )
    })
    // The snapshot must carry the desktop's own signed proof unchanged.
    if (!seesDesktop) throw new ProbePhaseError("relay_mismatch")

    await desktop.channel.expect(
      (frame) => {
        if (frame.kind !== "peerJoined" || frame.rendezvousId !== roomId) return undefined
        const proof = objectAt(objectAt(frame.peer)?.proof)
        return proof?.sessionId === mobileProof.sessionId && proof.role === "mobile"
          ? true
          : undefined
      },
      { deadlineAt: phaseDeadline(), timeoutReason: "peer_timeout", errorReason: "auth_rejected" }
    )

    const nonce = randomBase64Url(16)
    const relay = async (
      from: Peer,
      to: Peer,
      step: string,
      lane: "signal" | "data",
      extra: Record<string, string> = {}
    ): Promise<void> => {
      const payload = JSON.stringify({ probe: PAYLOAD_TAG, step, nonce, ...extra })
      budget.charge(payload)
      const fromSession = from.subscribe!.proof.sessionId
      // The receiver's frames are buffered from the moment its socket opened,
      // so sending first cannot race the read below.
      from.channel.send({
        kind: "relay",
        rendezvousId: roomId,
        payload,
        ...(lane === "data" ? { lane: "data" } : {}),
      })
      await to.channel.expect(
        (frame) => {
          if (frame.kind !== "relay" || frame.rendezvousId !== roomId) return undefined
          if (frame.fromSessionId !== fromSession) return undefined
          const received = typeof frame.payload === "string" ? frame.payload : ""
          const parsed = parsePayload(received)
          // A payload from another step or run is stale: skip, never accept.
          if (!parsed || parsed.step !== step || parsed.nonce !== nonce) return undefined
          const receivedLane = frame.lane === "data" ? "data" : "signal"
          if (received !== payload || receivedLane !== lane || frame.fromRole !== from.role) {
            throw new ProbePhaseError("relay_mismatch")
          }
          return true
        },
        // An `error` frame here means the relay refused or dropped the frame
        // (quota, rate limit, lost subscription): it did not carry it as sent.
        {
          deadlineAt: phaseDeadline(),
          timeoutReason: "relay_timeout",
          errorReason: "relay_mismatch",
        }
      )
    }

    await relay(mobile, desktop, "signal", "signal")
    await relay(desktop, mobile, "signal-ack", "signal")
    authDurationMs = now() - startedAt

    // --- relayData: explicit data lane, exact bytes both ways, then ping ---
    stage = "data"
    dataStartedAt = now()
    const data = randomBase64Url(limits.dataPayloadBytes)
    await relay(mobile, desktop, "data", "data", { data })
    await relay(desktop, mobile, "data-echo", "data", { data })
    const dataDurationMs = now() - dataStartedAt

    mobile.channel.send({ kind: "ping" })
    await mobile.channel.expect((frame) => (frame.kind === "pong" ? true : undefined), {
      deadlineAt: phaseDeadline(),
      timeoutReason: "relay_timeout",
      errorReason: "relay_mismatch",
    })

    return finish(pass("signalingAuth", authDurationMs), pass("relayData", dataDurationMs))
  } catch (error) {
    if (signal.aborted || error instanceof ProbeAbortedError) {
      return finish(
        stage === "data" && authDurationMs !== null
          ? pass("signalingAuth", authDurationMs)
          : unknown("signalingAuth", "runner_error", true),
        unknown("relayData", "runner_error", stage === "data"),
        true
      )
    }
    if (error instanceof ProbePhaseError) {
      if (stage === "auth") {
        return finish(fail("signalingAuth", error.reason, now() - startedAt), {
          checkId: "relayData",
          result: "unknown",
          durationMs: null,
          reason: "dependency_failed",
          attempted: false,
          dependsOn: "signalingAuth",
        })
      }
      return finish(
        pass("signalingAuth", authDurationMs ?? 0),
        fail("relayData", error.reason, now() - dataStartedAt)
      )
    }
    // Anything else is the runner's own fault: unknown, never a target failure.
    if (stage === "auth") {
      return finish(
        unknown("signalingAuth", "runner_error", true),
        unknown("relayData", "runner_error", false)
      )
    }
    return finish(
      pass("signalingAuth", authDurationMs ?? 0),
      unknown("relayData", "runner_error", true)
    )
  } finally {
    await cleanup(peers, limits.closeDeadlineMs)
  }
}

/**
 * Unsubscribe and close every socket, then wait at most `closeDeadlineMs`
 * for the close handshakes. Never throws: cleanup must not change a result.
 */
async function cleanup(peers: Peer[], closeDeadlineMs: number): Promise<void> {
  for (const peer of peers) {
    try {
      if (peer.subscribed && peer.subscribe) {
        peer.channel.send({ kind: "unsubscribe", rendezvousId: peer.subscribe.proof.roomId })
      }
    } catch {
      // The socket may already be closed; closing below is what matters.
    }
    try {
      peer.channel.socket.close()
    } catch {
      // Adapter contract says close() never throws; tolerate one that does.
    }
  }
  if (peers.length === 0) return
  await Promise.race([
    Promise.allSettled(peers.map((peer) => peer.channel.socket.closed)),
    sleep(closeDeadlineMs),
  ])
}

function classifyOpenError(error: unknown, origin: string | null, signal: AbortSignal): Error {
  if (signal.aborted || error instanceof ProbeAbortedError) return new ProbeAbortedError()
  if (error instanceof DeadlineError) return new ProbePhaseError("timeout")
  if (error instanceof ProbeTransportError) {
    if (error.httpStatus === 403 && origin !== null) return new ProbePhaseError("origin_rejected")
    if (
      error.reason === "dns_error" ||
      error.reason === "tls_error" ||
      error.reason === "connect_error" ||
      error.reason === "timeout"
    ) {
      return new ProbePhaseError(error.reason)
    }
    return new ProbePhaseError("ws_upgrade")
  }
  return error instanceof Error ? error : new Error(String(error))
}

function parsePayload(text: string): { step?: unknown; nonce?: unknown } | null {
  try {
    const value: unknown = JSON.parse(text)
    return objectAt(value) ?? null
  } catch {
    return null
  }
}

function pass(checkId: "signalingAuth" | "relayData", durationMs: number): CheckObservation {
  return {
    checkId,
    result: "pass",
    durationMs: Math.max(0, Math.round(durationMs)),
    reason: null,
    attempted: true,
    dependsOn: null,
  }
}

function fail(
  checkId: "signalingAuth" | "relayData",
  reason: ReasonCode,
  durationMs: number
): CheckObservation {
  return {
    checkId,
    result: "fail",
    durationMs: Math.max(0, Math.round(durationMs)),
    reason,
    attempted: true,
    dependsOn: null,
  }
}

function unknown(
  checkId: "signalingAuth" | "relayData",
  reason: ReasonCode,
  attempted: boolean
): CheckObservation {
  return { checkId, result: "unknown", durationMs: null, reason, attempted, dependsOn: null }
}
