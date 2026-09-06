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
import { transport } from "@/lib/tauri"
import { useSettingsStore } from "@/stores/settings"

export interface RelaySlice {
  /** Where the switch and URL were read from. */
  source: "host" | "local" | "unavailable"
  enabled: boolean
  signalingUrl: string
  /** The banner's word for the relay route. */
  route: RelayRouteState
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
  /** Test seams. */
  readSignalingStatus?: () => Promise<SignalingStatusSnapshot>
  readTunnel?: () => Promise<TunnelInfoSnapshot | null>
  readMesh?: () => Promise<MeshStatus>
  probe?: typeof probeRelay
}

const DEFAULT_POLL_MS = 5_000

const defaultReadSignalingStatus = () =>
  transport.call<SignalingStatusSnapshot>("companion_signaling_status")
const defaultReadTunnel = () =>
  transport.call<TunnelInfoSnapshot | null>("companion_tunnel_current")
const defaultReadMesh = () => transport.call<MeshStatus>("companion_mesh_status")

export function useRemoteAccess(options: UseRemoteAccessOptions = {}): RemoteAccessState {
  const {
    pollMs = DEFAULT_POLL_MS,
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
      if (meshReach.available) {
        try {
          const status = await readers.current.readMesh()
          if (live) setMesh(status)
        } catch {
          if (live) setMesh(null)
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
  }, [meshReach.available, pollMs, signalingReach.available, tunnelReach.available])

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

  const check = useCallback(async () => {
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    setChecking(true)
    try {
      const next = await readers.current.probe(signalingUrl, { signal: controller.signal })
      if (controller.signal.aborted) return
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

  const route: RelayRouteState = !enabled ? "off" : result ? result.state : "unchecked"

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
    relay: { source, enabled, signalingUrl, route, result, checkedAt, checking, check },
    tunnel: {
      available: tunnelReach.available,
      publicUrl: tunnel?.publicUrl ?? null,
      localUrl: tunnel?.localUrl ?? null,
    },
    mesh: { available: meshReach.available, status: mesh, refresh: refreshMesh },
  }
}
