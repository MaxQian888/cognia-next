/**
 * "Can a device away from this network reach this Host?", as one word.
 *
 * The Cloud & relay topic shows three routes out of the building (the
 * hosted relay, a public tunnel, an overlay network) and each has its own
 * block. This is the sentence above them, the way Plex's "Remote Access"
 * banner reads before its settings. Pure, so the verdict is testable without
 * a Host, and the same function feeds the settings banner and the tests.
 */

import type { RelayProbeState } from "@/lib/signaling/relay-probe"

/** The relay route, as the banner sees it. */
export type RelayRouteState =
  | RelayProbeState
  /** The WebRTC master switch is off: the Host dials no rendezvous. */
  | "off"
  /** The switch is on but nobody has probed yet this session. */
  | "unchecked"

export interface RemoteAccessInput {
  /** Whether this shell is a Host (desktop or headless). */
  isHost: boolean
  relay: RelayRouteState
  /** A cloudflared tunnel is serving a public URL right now. */
  tunnelOn: boolean
  /** An overlay-network interface carries an address right now. */
  meshConnected: boolean
}

export type RemoteAccessVerdict =
  /** A device on any network can pair and connect. */
  | "anywhere"
  /** Any network can pair, but the rendezvous cannot carry app traffic. */
  | "anywhereLegacy"
  /** Only a device on the same overlay network. */
  | "meshOnly"
  /** Only a device on this LAN. */
  | "lanOnly"
  /** No route is proven yet: the relay has not been checked. */
  | "unknown"
  /** Not a Host, so the question does not apply. */
  | "notHost"

export function remoteAccessVerdict(input: RemoteAccessInput): RemoteAccessVerdict {
  if (!input.isHost) return "notHost"
  if (input.tunnelOn || input.relay === "ready") return "anywhere"
  // A relay that answered but would not let this browser origin read the
  // answer is a pre-CORS deployment: up, and older than the data lane.
  if (input.relay === "legacy" || input.relay === "cors-blocked") return "anywhereLegacy"
  if (input.meshConnected) return "meshOnly"
  if (input.relay === "unchecked") return "unknown"
  return "lanOnly"
}
