/**
 * Commands over a device's relay room (ADR-0224 A4).
 *
 * `cognia-agent host login --invitation 'cgnp4|…'` can pair with a host that
 * only the relay reaches: a Mac mini behind a home router, a VPS with no open
 * port. Registration hands back a relay room of the CLI's own (`rendezvousId`,
 * the signed room descriptor, the device's signaling key), and the host joins
 * it for as long as the pairing lives. Until now the CLI threw that away and
 * sent every later command to the host's address, so a host paired from
 * another network accepted the pairing and then could not be used.
 *
 * This joins that room the way the app's companion transport does when its
 * direct route fails: relay only, no WebRTC negotiation (Node has none), and
 * end-to-end encrypted to the host, so the relay sees only ciphertext. The
 * host authenticates the room against the pairing, so the lane carries the
 * device's own grants and no bearer token.
 *
 * Only commands travel this way. The relay lane is the RPC plane; arbitrary
 * HTTP routes (`api request GET /…`, operation receipts) have no relay form.
 */

import { importSigningPrivateKey, type RoomDescriptor } from "@/lib/signaling/crypto"
import { DEFAULT_SIGNALING_URL } from "@/lib/signaling/types"
import { TransportRtc, type TransportRtcOptions } from "@/lib/tauri/transport-rtc"

import type { FailureCause } from "../cli/errors"
import type { CommandOutcome, RequestOptions } from "./transport"

/** What a host record keeps to reach the host through its relay room. */
export interface RelayRouteRecord {
  /** Absent means the public signaling service. */
  signalingUrl?: string
  rendezvousId: string
  roomDescriptor: RoomDescriptor
  signalingPrivateKeyJwk: JsonWebKey
}

/**
 * How long joining the room may take. The host is already subscribed to it,
 * so this is one signaling round trip plus the room's key exchange.
 */
export const RELAY_HANDSHAKE_TIMEOUT_MS = 15_000

export interface RelayCommandChannel {
  execute: (
    name: string,
    args: Record<string, unknown>,
    options?: RequestOptions
  ) => Promise<CommandOutcome>
  close: () => void
}

export interface RelayCommandChannelOptions {
  route: RelayRouteRecord
  deviceId: string
  handshakeTimeoutMs?: number
  /** Test injection. */
  transportFactory?: (options: TransportRtcOptions) => TransportRtc
}

/**
 * The relay lane answers with the host's own problem codes and no HTTP
 * status, so the cause is read from the code, in the same vocabulary
 * `classifyStatus` uses for the direct wire.
 */
export function classifyRelayCode(code: string | undefined): FailureCause {
  switch (code) {
    case "unknown_command":
      return "unknown-command"
    case "interactive_approval_required":
    case "signed_policy_required":
    case "command_transport_forbidden":
    case "rate_limited":
      return "refused"
    case "device_revoked":
    case "unauthorized":
    case "forbidden":
    case "missing_grant":
      return "auth"
    case "invalid_request":
    case "invalid_params":
    case "validation_failed":
      return "invalid-request"
    case "timeout":
      return "timeout"
    default:
      return "failed"
  }
}

function isHostError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && typeof (error as { code?: unknown }).code === "string"
}

/** Join the room lazily, on the first command, and reuse it after that. */
export function relayCommandChannel(options: RelayCommandChannelOptions): RelayCommandChannel {
  const factory = options.transportFactory ?? ((o: TransportRtcOptions) => new TransportRtc(o))
  const timeoutMs = options.handshakeTimeoutMs ?? RELAY_HANDSHAKE_TIMEOUT_MS
  let opening: Promise<TransportRtc> | null = null
  let closed = false

  const open = (): Promise<TransportRtc> => {
    opening ??= (async () => {
      const signalingPrivateKey = await importSigningPrivateKey(
        options.route.signalingPrivateKeyJwk
      )
      const rtc = factory({
        signalingUrl: options.route.signalingUrl ?? DEFAULT_SIGNALING_URL,
        rendezvousId: options.route.rendezvousId,
        signalingRoomDescriptor: options.route.roomDescriptor,
        signalingPrivateKey,
        deviceId: options.deviceId,
        role: "mobile",
        // Node has no WebRTC: the relay carrier is the whole route.
        p2p: false,
        // One process, one session: nothing to resume from storage.
        persistEventCursor: false,
        relayHandshakeTimeoutMs: timeoutMs,
        peerWaitTimeoutMs: timeoutMs,
      })
      try {
        await rtc.connect()
      } catch (error) {
        rtc.close()
        throw error
      }
      return rtc
    })()
    // A failed join is not cached; the next command tries again.
    opening.catch(() => {
      opening = null
    })
    return opening
  }

  return {
    async execute(name, args, requestOptions) {
      if (closed) return { ok: false, cause: "network", message: "the relay route is closed" }
      let rtc: TransportRtc
      try {
        rtc = await open()
      } catch (error) {
        return {
          ok: false,
          cause: "network",
          message: `the host's relay room could not be joined: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }
      }
      try {
        const result = await rtc.call<unknown>(name, args, {
          ...(requestOptions?.idempotencyKey
            ? { idempotencyKey: requestOptions.idempotencyKey }
            : {}),
          ...(requestOptions?.timeoutMs && requestOptions.timeoutMs > 0
            ? { deadlineAt: Date.now() + requestOptions.timeoutMs }
            : {}),
        })
        const operationId =
          result && typeof result === "object"
            ? (result as { operationId?: unknown }).operationId
            : undefined
        return typeof operationId === "string" &&
          (result as { status?: unknown }).status === "running"
          ? { ok: true, accepted: true, result, operationId }
          : { ok: true, result }
      } catch (error) {
        if (isHostError(error)) {
          return {
            ok: false,
            cause: classifyRelayCode(error.code),
            message: error.message,
            code: error.code,
          }
        }
        const message = error instanceof Error ? error.message : String(error)
        return {
          ok: false,
          cause: /timed out/.test(message) ? "timeout" : "network",
          message,
        }
      }
    },
    close() {
      closed = true
      void opening?.then((rtc) => rtc.close()).catch(() => undefined)
    },
  }
}
