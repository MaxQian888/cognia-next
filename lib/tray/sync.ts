// Wire-up that pushes the renderer's tray store + relevant app-state into
// Rust's `tray_set_menu` / `tray_set_icon_state` / `tray_set_tooltip` IPC.
//
// The hook is mounted exactly once (alongside `useTauriEvents`) from
// `components/providers/tauri-provider.tsx`. Pushes are debounced so a
// burst of zustand updates (e.g. a goal flip + automation start) coalesces
// into one DTO build / IPC round-trip.

"use client"

import { useEffect, useRef } from "react"
import { invoke } from "@tauri-apps/api/core"
import { useTranslations } from "next-intl"
import { loggers } from "@/lib/logger"
import { isTauri } from "@/lib/tauri"

import { buildTrayPayload } from "./builder"
import { subscribeTrayItems } from "./registry"
import { useTrayStore } from "./store"
import { useTrayStateSnapshot } from "./state-snapshot"
import type { TrayStateSnapshot } from "./types"

const PUSH_DEBOUNCE_MS = 150

/**
 * Static fallback snapshot used by tests that don't mount a provider tree
 * and by the sync hook's first paint (before React commits the live
 * snapshot). Production paths use `useTrayStateSnapshot()` which reads
 * the real chat / goal / automation / platform state.
 */
export function defaultSnapshot(): TrayStateSnapshot {
  const os =
    typeof navigator !== "undefined" && navigator.platform
      ? navigator.platform.toLowerCase().includes("win")
        ? "windows"
        : navigator.platform.toLowerCase().includes("mac")
          ? "macos"
          : navigator.platform.toLowerCase().includes("linux")
            ? "linux"
            : "unknown"
      : "unknown"
  return {
    goal: { active: false, paused: false },
    automation: { running: false, armed: true },
    chat: { streaming: false, hasActiveSession: false },
    platform: { os: os as TrayStateSnapshot["platform"]["os"] },
  }
}

/**
 * React hook: subscribes to the tray store + plugin tray-item registry,
 * builds a fresh DTO when either fires, and flushes it to Rust.
 * Mount once at the app root.
 */
export function useSyncTrayToRust(): void {
  const t = useTranslations("tray")
  const tooltipKey = useTrayStore((s) => s.tooltip)
  const iconState = useTrayStore((s) => s.iconState)
  const items = useTrayStore((s) => s.items)
  const hydrated = useTrayStore((s) => s.hydrated)
  // Live state snapshot. Reading it as a hook means every store change
  // (chat streaming flip, goal pause, kill-switch engage, …) re-runs the
  // sync effect and pushes a fresh DTO. The snapshot itself is cheap to
  // build — the heavy DTO work is debounced below.
  const snapshot = useTrayStateSnapshot()
  const lastPushedTooltip = useRef<string | null>(null)
  const lastPushedIcon = useRef<string | null>(null)
  const debounceHandle = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Menu pushes — debounced, re-runs on store or plugin registry change
  // or any when-relevant snapshot transition.
  useEffect(() => {
    if (!isTauri() || !hydrated) return

    function flush() {
      const dto = buildTrayPayload({
        items,
        t: ((key: string) => t(key as never)) as (key: string) => string,
        snapshot,
      })
      void invoke("tray_set_menu", { items: dto }).catch((err) => {
        loggers.tray.warn("tray_set_menu failed", { error: String(err) })
      })
    }

    function schedule() {
      if (debounceHandle.current) clearTimeout(debounceHandle.current)
      debounceHandle.current = setTimeout(() => {
        debounceHandle.current = null
        flush()
      }, PUSH_DEBOUNCE_MS)
    }

    // Initial flush + subsequent refreshes from the plugin tray registry.
    schedule()
    const off = subscribeTrayItems(schedule)
    return () => {
      off()
      if (debounceHandle.current) clearTimeout(debounceHandle.current)
    }
  }, [items, t, hydrated, snapshot])

  // Icon state — small enough that we don't debounce; only push on change.
  useEffect(() => {
    if (!isTauri() || !hydrated) return
    if (lastPushedIcon.current === iconState) return
    lastPushedIcon.current = iconState
    void invoke("tray_set_icon_state", { state: iconState }).catch((err) => {
      loggers.tray.warn("tray_set_icon_state failed", { error: String(err) })
    })
  }, [iconState, hydrated])

  // Tooltip — same idea as icon state.
  useEffect(() => {
    if (!isTauri() || !hydrated) return
    if (lastPushedTooltip.current === tooltipKey) return
    lastPushedTooltip.current = tooltipKey
    void invoke("tray_set_tooltip", { text: tooltipKey }).catch((err) => {
      loggers.tray.warn("tray_set_tooltip failed", { error: String(err) })
    })
  }, [tooltipKey, hydrated])
}
