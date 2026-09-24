"use client"

/**
 * The three routes out of the building, read from wherever the truth is.
 *
 * - **Relay**: the Host's signaling switch and URL come from the host-admin
 *   `companion_signaling_status` arm on any shell that has a Host (desktop,
 *   headless, paired companion). A standalone browser has no Host, so it
 *   reads its own setting: that is what a Host started from here would dial.
 *   The rendezvous itself is probed on demand (`lib/signaling/relay-probe`),
 *   never automatically, because the answer is a network round-trip the user
 *   asked for and the last one is shown with its time.
 * - **Tunnel** and **mesh** are desktop-process facts (`host-admin-reach`
 *   says why), polled while the topic is open so a tunnel started from the
 *   Connections tab shows up here without a reload.
 */

import { useCallback, useEffect, useRef, useState } from "react"

import { useHostAdminReachForCommand } from "@/hooks/connectivity/use-host-admin-reach"
import { useHostProfile } from "@/hooks/use-host-profile"
import type { MeshStatus } from "@/lib/connectivity/mesh"
import type { RelayRouteState } from "@/lib/connectivity/remote-access"
import { probeRelay, type RelayProbeResult } from "@/lib/signaling/relay-probe"
import { DEFAULT_SIGNALING_URL } from "@/lib/signaling/types"
import { isTauri, localTransport, transport } from "@/lib/tauri"
import { useSettingsStore } from "@/stores/settings"

export interface RelaySlice {
  /** Where the switch and URL were read from. */
  source: "host" | "local" | "unavailable"
  enabled: boolean
  signalingUrl: string
  /** The banner's word for the relay route. */
  route: RelayRouteState
  /**
   * Whether the probe ran on the Host itself. `probeRelay` fetches through
   * *this* shell's transport, so on a paired companion it measures the phone's
   * network, not the Host's. A result from elsewhere is shown, but it never
   * upgrades the verdict.
   */
  probedFromHost: boolean
  result: RelayProbeResult | null
  checkedAt: number | null
  checking: boolean
  check: () => Promise<void>
}

export interface TunnelSlice {
  available: boolean
  publicUrl: string | null
  localUrl: string | null
}

export interface MeshSlice {
  available: boolean
  status: MeshStatus | null
  refresh: () => Promise<void>
}

export interface RemoteAccessState {
  isHost: boolean
  relay: RelaySlice
  tunnel: TunnelSlice
  mesh: MeshSlice
}

interface SignalingStatusSnapshot {
  enabled: boolean
  signalingUrl: string
}

interface TunnelInfoSnapshot {
  publicUrl: string
  localUrl: string
}

export interface UseRemoteAccessOptions {
  /** How often the desktop-process facts are re-read. `0` disables polling. */
  pollMs?: number
  /**
   * How often the overlay answer is re-read. `0` disables it. Much slower than
   * {@link pollMs} on purpose: `companion_mesh_status` walks every network
   * interface and stats the install locations of two clients, to answer a
   * question that only changes when a VPN client is installed or a daemon
   * starts. The block's own refresh button covers the impatient case.
   */
  meshPollMs?: number
  /** Test seams. */
  readSignalingStatus?: () => Promise<SignalingStatusSnapshot>
  readTunnel?: () => Promise<TunnelInfoSnapshot | null>
  readMesh?: () => Promise<MeshStatus>
  probe?: typeof probeRelay
}

const DEFAULT_POLL_MS = 5_000
const DEFAULT_MESH_POLL_MS = 60_000

const defaultReadSignalingStatus = () =>
  (isTauri() ? localTransport : transport).call<SignalingStatusSnapshot>(
    "companion_signaling_status"
  )
const defaultReadTunnel = () =>
  localTransport.call<TunnelInfoSnapshot | null>("companion_tunnel_current")
const defaultReadMesh = () => localTransport.call<MeshStatus>("companion_mesh_status")

export function useRemoteAccess(options: UseRemoteAccessOptions = {}): RemoteAccessState {
  const {
    pollMs = DEFAULT_POLL_MS,
    meshPollMs = DEFAULT_MESH_POLL_MS,
    readSignalingStatus = defaultReadSignalingStatus,
    readTunnel = defaultReadTunnel,
    readMesh = defaultReadMesh,
    probe = probeRelay,
  } = options
  const profile = useHostProfile()
  const isHost = profile === "desktop" || profile === "headless"
  const signalingReach = useHostAdminReachForCommand("companion_signaling_status")
  const tunnelReach = useHostAdminReachForCommand("companion_tunnel_current")
  const meshReach = useHostAdminReachForCommand("companion_mesh_status")
  const settings = useSettingsStore((s) => s.settings)

  const [hostSignaling, setHostSignaling] = useState<SignalingStatusSnapshot | null>(null)
  const [hostSignalingFailed, setHostSignalingFailed] = useState(false)
  const [tunnel, setTunnel] = useState<TunnelInfoSnapshot | null>(null)
  const [mesh, setMesh] = useState<MeshStatus | null>(null)
  const [result, setResult] = useState<RelayProbeResult | null>(null)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [checking, setChecking] = useState(false)
  const inFlight = useRef<AbortController | null>(null)
  // The readers are held in a ref so a caller passing fresh closures on every
  // render (tests do, and any parent could) does not re-arm the poll effect
  // per render, which with a poll that sets state is a render loop.
  const readers = useRef({ readSignalingStatus, readTunnel, readMesh, probe })
  useEffect(() => {
    readers.current = { readSignalingStatus, readTunnel, readMesh, probe }
  }, [probe, readMesh, readSignalingStatus, readTunnel])

  // Desktop-process facts, polled while mounted. Reads from promise callbacks
  // only, so the lint rule on synchronous effect writes stays honest.
  useEffect(() => {
    let live = true
    const tick = async () => {
      if (signalingReach.available) {
        try {
          const snapshot = await readers.current.readSignalingStatus()
          if (live) {
            setHostSignaling(snapshot)
            setHostSignalingFailed(false)
          }
        } catch {
          if (live) setHostSignalingFailed(true)
        }
      }
      if (tunnelReach.available) {
        try {
          const info = await readers.current.readTunnel()
          if (live) setTunnel(info)
        } catch {
          if (live) setTunnel(null)
        }
      }
    }
    void tick()
    if (pollMs <= 0) {
      return () => {
        live = false
      }
    }
    const id = setInterval(() => void tick(), pollMs)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [pollMs, signalingReach.available, tunnelReach.available])

  // The overlay answer on its own, much slower clock: see `meshPollMs`.
  useEffect(() => {
    if (!meshReach.available) return
    let live = true
    const tick = async () => {
      try {
        const status = await readers.current.readMesh()
        if (live) setMesh(status)
      } catch {
        if (live) setMesh(null)
      }
    }
    void tick()
    if (meshPollMs <= 0) {
      return () => {
        live = false
      }
    }
    const id = setInterval(() => void tick(), meshPollMs)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [meshPollMs, meshReach.available])

  const source: RelaySlice["source"] = signalingReach.available
    ? hostSignalingFailed && !hostSignaling
      ? "unavailable"
      : "host"
    : profile === "web-standalone"
      ? "local"
      : "unavailable"
  const enabled =
    source === "host"
      ? (hostSignaling?.enabled ?? true)
      : source === "local"
        ? (settings?.webrtcEnabled ?? true)
        : false
  const signalingUrl =
    source === "host"
      ? (hostSignaling?.signalingUrl ?? DEFAULT_SIGNALING_URL)
      : (settings?.signalingUrl ?? DEFAULT_SIGNALING_URL)

  // A probe answers for one rendezvous. When the configured URL changes — the
  // user edits it below, or the Host reports a new one — the old verdict stops
  // being about anything on screen, so it is dropped and the check re-offered
  // rather than left claiming `ready` for an address no longer in use.
  const probedUrl = useRef<string | null>(null)
  const observedUrl = useRef<string | null>(null)
  useEffect(() => {
    const previous = observedUrl.current
    observedUrl.current = signalingUrl
    if (previous === null || previous === signalingUrl) return
    // A probe still in flight was launched for the PREVIOUS rendezvous. Abort
    // it so the `aborted` check in `check` refuses to commit: left running it
    // resolves after this effect has already gone, stamps `probedUrl` with the
    // old address and sets a result this effect will never fire again to clear.
    inFlight.current?.abort()
    probedUrl.current = null
    setResult(null)
    setCheckedAt(null)
  }, [signalingUrl])

  const check = useCallback(async () => {
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    setChecking(true)
    try {
      const next = await readers.current.probe(signalingUrl, { signal: controller.signal })
      if (controller.signal.aborted) return
      probedUrl.current = signalingUrl
      setResult(next)
      setCheckedAt(Date.now())
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null
        setChecking(false)
      }
    }
  }, [signalingUrl])

  useEffect(() => () => inFlight.current?.abort(), [])

  // `probeRelay` goes out over *this* shell's transport. Only when this shell
  // is the Host does the answer say anything about the Host's own reach; from
  // a paired companion it measures the phone's network, so the result is still
  // shown and explained, but the route stays unproven.
  const probedFromHost = isHost
  const route: RelayRouteState = !enabled
    ? "off"
    : result && probedFromHost
      ? result.state
      : "unchecked"

  const refreshMesh = useCallback(async () => {
    if (!meshReach.available) return
    try {
      setMesh(await readers.current.readMesh())
    } catch {
      setMesh(null)
    }
  }, [meshReach.available])

  return {
    isHost,
    relay: {
      source,
      enabled,
      signalingUrl,
      route,
      probedFromHost,
      result,
      checkedAt,
      checking,
      check,
    },
    tunnel: {
      available: tunnelReach.available,
      publicUrl: tunnel?.publicUrl ?? null,
      localUrl: tunnel?.localUrl ?? null,
    },
    mesh: { available: meshReach.available, status: mesh, refresh: refreshMesh },
  }
}
