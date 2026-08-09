"use client"

/**
 * Mounts the Rust → Dexie event bridge for the mobile-companion subsystem,
 * plus the WebRTC signaling controllers introduced in ADR-0021.
 *
 * - `installCompanionEventBridge` subscribes to `companion://device-paired`
 *   and `companion://device-seen` via the shared transport and persists
 *   the payloads to the `pairedDevices` Dexie table.
 * - `installDesktopSignalingController` keeps the Rust `SignalingHub` in
 *   sync with Dexie + AppSettings on the desktop Tauri renderer.
 * - `installCompanionSignalingController` drives the live `CompanionTransport`
 *   — channel inventory, reconnect probing, failover and the WebRTC tier — on
 *   the Capacitor renderer and in a browser pointed at a cloud server. It
 *   self-gates, so this mount stays unconditional.
 *
 * All three are idempotent and safe to mount under React strict-mode
 * double-render — each `useEffect` returns its own detach handle.
 */

import { useEffect } from "react"
import { installCompanionEventBridge } from "@/lib/companion/event-bridge"
import {
  installDesktopSignalingController,
  installCompanionSignalingController,
} from "@/lib/signaling"
import { CompanionOutboundRunnerProvider } from "./companion-outbound-runner-provider"

export function CompanionEventBridgeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (typeof window === "undefined") return
    let detachEventBridge = () => {}
    let detachCompanionSignaling = () => {}

    const bindActiveTransport = () => {
      detachEventBridge()
      detachCompanionSignaling()
      detachEventBridge = installCompanionEventBridge()
      detachCompanionSignaling = installCompanionSignalingController()
    }

    bindActiveTransport()
    window.addEventListener("cognia:companion-config-changed", bindActiveTransport)
    return () => {
      window.removeEventListener("cognia:companion-config-changed", bindActiveTransport)
      detachEventBridge()
      detachCompanionSignaling()
    }
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    const detach = installDesktopSignalingController()
    return detach
  }, [])

  return (
    <>
      <CompanionOutboundRunnerProvider />
      {children}
    </>
  )
}
