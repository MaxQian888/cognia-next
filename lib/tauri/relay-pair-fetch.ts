"use client"

/**
 * The pairing handshake over the relay (ADR-0170, `cgnp4`).
 *
 * `registerCompanionDevice` speaks HTTP through an injectable `AuthFetcher`.
 * This module builds one that never touches the network stack the Host is
 * unreachable on: it joins the invitation's one-shot pairing room, opens the
 * relay data lane, and turns each `fetch(url, init)` into a `pair.http` RPC
 * frame the Host answers by driving its own router. The four public pairing
 * requests therefore run unchanged, and a device that has never seen the
 * Host's LAN, or a browser that can never trust its certificate, pairs from
 * anywhere the rendezvous is reachable.
 *
 * The room's mobile key arrives inside the invitation as a JWK and is worth
 * exactly what the one-shot invitation is worth. It is imported
 * non-extractable and discarded with the transport.
 */

import { importSigningPrivateKey } from "@/lib/signaling/crypto"
import type { PairRelay } from "@/lib/qr/pair-payload"
import { TransportRtc, type TransportRtcOptions } from "@/lib/tauri/transport-rtc"
import type { PinnedFetchInit } from "@/lib/tauri/pinned-fetch"

/** How long to wait for the Host to answer `hello` on the pairing room. */
export const PAIRING_ROOM_HANDSHAKE_TIMEOUT_MS = 12_000

/** What the Host returns for one `pair.http` request. */
interface PairHttpResponse {
  status: number
  headers: [string, string][]
  body: string
}

export interface RelayPairFetcher {
  /** Drop-in `AuthFetcher`. */
  fetcher: (url: string, init?: PinnedFetchInit) => Promise<Response>
  /** Leave the pairing room. Idempotent. */
  close: () => void
}

export interface RelayPairFetcherOptions {
  /** Test injection of the transport factory. */
  transportFactory?: (options: TransportRtcOptions) => TransportRtc
  /** Override the handshake wait (tests). */
  handshakeTimeoutMs?: number
}

/**
 * Join the invitation's pairing room and hand back a fetcher over it. Rejects
 * when the Host does not show up in the room within the handshake window,
 * which is the relay-era reading of "nothing is listening".
 */
export async function createRelayPairFetcher(
  relay: PairRelay,
  options: RelayPairFetcherOptions = {}
): Promise<RelayPairFetcher> {
  const signingPrivateKey = await importSigningPrivateKey(relay.mobilePrivateKeyJwk)
  const factory = options.transportFactory ?? ((o) => new TransportRtc(o))
  const rtc = factory({
    signalingUrl: relay.url,
    rendezvousId: relay.room.roomId,
    signalingRoomDescriptor: relay.room,
    signalingPrivateKey: signingPrivateKey,
    deviceId: `pairing:${relay.room.roomId}`,
    role: "mobile",
    // No identity yet, so no ICE: the pairing room is relay-only by design.
    p2p: false,
    relayHandshakeTimeoutMs: options.handshakeTimeoutMs ?? PAIRING_ROOM_HANDSHAKE_TIMEOUT_MS,
    peerWaitTimeoutMs: options.handshakeTimeoutMs ?? PAIRING_ROOM_HANDSHAKE_TIMEOUT_MS,
  })
  await rtc.connect()
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    rtc.close()
  }
  const fetcher = async (url: string, init: PinnedFetchInit = {}): Promise<Response> => {
    if (closed) throw new Error("relay pairing room is closed")
    const parsed = new URL(url)
    const headers: [string, string][] = []
    const source = init.headers
    if (source instanceof Headers) {
      source.forEach((value, key) => headers.push([key, value]))
    } else if (Array.isArray(source)) {
      for (const [key, value] of source) headers.push([key, value])
    } else if (source && typeof source === "object") {
      for (const [key, value] of Object.entries(source)) headers.push([key, String(value)])
    }
    const body = typeof init.body === "string" ? init.body : undefined
    const answer = await rtc.call<PairHttpResponse>("pair.http", {
      method: (init.method ?? "GET").toUpperCase(),
      path: `${parsed.pathname}${parsed.search}`,
      headers,
      body,
    })
    if (
      !answer ||
      typeof answer !== "object" ||
      typeof answer.status !== "number" ||
      typeof answer.body !== "string"
    ) {
      throw new Error("relay pairing answer is malformed")
    }
    return new Response(answer.body, {
      status: answer.status,
      headers: Array.isArray(answer.headers) ? answer.headers : [],
    })
  }
  return { fetcher, close }
}
