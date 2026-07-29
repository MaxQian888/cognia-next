/**
 * The four channels a paired client can reach this desktop on, folded into one
 * table.
 *
 * Companion settings had the pieces but never the picture: the bind mode lived
 * on the server card, mDNS on its own card, the tunnel on a third, WebRTC on a
 * fourth, and the reachability probe printed a flat list of URLs with no idea
 * which channel each one was. Answering "can my phone reach this machine from a
 * café, and over what" meant reading four cards and knowing how they relate.
 *
 * The row builder is pure so the rules are testable without a Tauri host — the
 * component below it only renders what this returns.
 */

import { classifyWsHost } from "@/lib/connectivity/lan-classify"

export type ChannelId = "lan" | "mdns" | "tunnel" | "webrtc"

/**
 * - `live` — configured and serving right now.
 * - `off` — could serve, but the user has it switched off.
 * - `blocked` — switched on, yet something upstream makes it unusable (the
 *   server is stopped, or it is bound to loopback so nothing off-machine can
 *   reach it). Distinct from `off` because the fix is somewhere else.
 */
export type ChannelState = "live" | "off" | "blocked"

export interface ChannelRow {
  id: ChannelId
  state: ChannelState
  /** Address a client would use. Absent when there is nothing to show yet. */
  address?: string
  /** Result of the last probe, when one has run and covered this channel. */
  reachable?: boolean
  latencyMs?: number
  probeError?: string
  /**
   * Why this row is `blocked`, as an i18n key suffix under
   * `mobile.companion.channels.blocked.*`. Only set when `state === "blocked"`.
   */
  blockedReason?: "serverStopped" | "loopbackOnly" | "noSignaling"
}

export interface ServerSnapshot {
  running: boolean
  bindMode: "loopback" | "lan" | "none"
  boundPort: number | null
}

export interface ProbeResult {
  url: string
  reachable: boolean
  latencyMs?: number
  error?: string
}

export interface BuildChannelRowsInput {
  server: ServerSnapshot
  mdnsOn: boolean
  /** Public URL of the running tunnel, or null when no tunnel is up. */
  tunnelUrl: string | null
  webrtcEnabled: boolean
  signalingUrl?: string
  /** Rows from `companion_test_local_reachability`; empty until a probe runs. */
  probes?: readonly ProbeResult[]
}

/** Loopback answers only this machine, so it is never a channel a phone can use. */
function isLoopback(url: string): boolean {
  try {
    const { hostname } = new URL(url)
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  } catch {
    return false
  }
}

/** Best probe for a channel: prefer a reachable one, else report the failure. */
function pickProbe(
  probes: readonly ProbeResult[],
  predicate: (url: string) => boolean
): ProbeResult | undefined {
  const matches = probes.filter((p) => predicate(p.url))
  return matches.find((p) => p.reachable) ?? matches[0]
}

function withProbe(row: ChannelRow, probe: ProbeResult | undefined): ChannelRow {
  if (!probe) return row
  return {
    ...row,
    address: row.address ?? probe.url,
    reachable: probe.reachable,
    latencyMs: probe.latencyMs,
    probeError: probe.error,
  }
}

export function buildChannelRows(input: BuildChannelRowsInput): ChannelRow[] {
  const { server, mdnsOn, tunnelUrl, webrtcEnabled, signalingUrl } = input
  const probes = input.probes ?? []

  // LAN — the direct route. Bound to loopback it technically runs, but nothing
  // off this machine can use it, which is the distinction the old server card
  // buried in a warning paragraph.
  const lanProbe = pickProbe(probes, (url) => !isLoopback(url) && classifyWsHost(url) === "ws-lan")
  const lan: ChannelRow = !server.running
    ? { id: "lan", state: "blocked", blockedReason: "serverStopped" }
    : server.bindMode === "loopback"
      ? { id: "lan", state: "blocked", blockedReason: "loopbackOnly" }
      : { id: "lan", state: "live" }

  // mDNS only advertises; with the server down there is nothing to advertise.
  const mdns: ChannelRow = !server.running
    ? { id: "mdns", state: "blocked", blockedReason: "serverStopped" }
    : mdnsOn
      ? { id: "mdns", state: "live" }
      : { id: "mdns", state: "off" }

  const tunnel: ChannelRow = tunnelUrl
    ? { id: "tunnel", state: "live", address: tunnelUrl }
    : { id: "tunnel", state: "off" }

  // WebRTC needs a rendezvous server to introduce the peers; without one the
  // switch is on and the channel still cannot be established.
  const webrtc: ChannelRow = !webrtcEnabled
    ? { id: "webrtc", state: "off" }
    : signalingUrl
      ? { id: "webrtc", state: "live", address: signalingUrl }
      : { id: "webrtc", state: "blocked", blockedReason: "noSignaling" }

  return [
    withProbe(lan, lanProbe),
    mdns,
    withProbe(tunnel, tunnelUrl ? pickProbe(probes, (url) => url === tunnelUrl) : undefined),
    webrtc,
  ]
}

/**
 * One-line verdict for the card header: can anything off this machine reach it?
 *
 * `blocked` beats `off` — a channel the user switched on but that cannot work
 * is the thing worth surfacing, and it is exactly the state the old layout hid.
 */
export function summarizeChannels(rows: readonly ChannelRow[]): "reachable" | "blocked" | "none" {
  if (rows.some((row) => row.state === "live")) return "reachable"
  if (rows.some((row) => row.state === "blocked")) return "blocked"
  return "none"
}
