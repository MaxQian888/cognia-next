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
 * - `installMobileSignalingController` opts the live `CompanionTransport`
 *   into the WebRTC tier on the Capacitor renderer.
 *
 * All three are idempotent and safe to mount under React strict-mode
 * double-render — each `useEffect` returns its own detach handle.
 */

import { useEffect } from "react"
import { installCompanionEventBridge } from "@/lib/companion/event-bridge"
import {
  installDesktopSignalingController,
  installMobileSignalingController,
} from "@/lib/signaling"

export function CompanionEventBridgeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (typeof window === "undefined") return
    const detach = installCompanionEventBridge()
    return detach
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    const detach = installDesktopSignalingController()
    return detach
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    const detach = installMobileSignalingController()
    return detach
  }, [])

  return <>{children}</>
}
