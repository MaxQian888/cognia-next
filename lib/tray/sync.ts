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

import { buildTrayPayload, type TrayTranslator } from "./builder"
import { subscribeTrayItems } from "./registry"
import { useTrayStore } from "./store"
import { useTrayStateSnapshot } from "./state-snapshot"
import type { TrayStateSnapshot } from "./types"

const PUSH_DEBOUNCE_MS = 150

/**
 * Shape of the translator returned by next-intl's `useTranslations()`. We only
 * need the call signature and `.has(key)` predicate; the rest of the surface
 * (`rich`, `markup`, `raw`, formatter helpers, …) is intentionally omitted so
 * tests can pass a minimal stand-in without recreating all of next-intl.
 */
export interface NextIntlTranslator {
  (key: string): string
  has(key: string): boolean
}

/**
 * Wrap a next-intl translator so that *unknown* keys flow through as-is
 * instead of throwing `MISSING_MESSAGE`. The tray's `label` field carries two
 * kinds of strings: i18n keys (e.g. `tray.show`, `tray.categories.chat` from
 * `defaults.ts` and `all-commands.ts`) and literal display strings (slash
 * command names like `/clear`, plugin tray-item labels, command titles).
 * The builder calls `t(label)` on every entry; without this guard, the
 * literal-label path crashes the tray rebuild under production next-intl.
 *
 * Exported for direct unit testing — see `sync.test.ts`. Use through
 * `useSyncTrayToRust` in production.
 */
export function makeResilientTrayTranslator(t: NextIntlTranslator): TrayTranslator {
  return (key: string) => (t.has(key) ? t(key) : key)
}

/**
 * Read the tooltip Rust currently has registered for the tray icon. Returns
 * `null` outside Tauri (web mode never installs a tray) and on IPC failure.
 *
 * The renderer is the source of truth: `tray_set_tooltip` is the write
 * path. This getter exists for diagnostic surfaces ("does Rust agree with
 * the renderer right now?") and for hydration-time reconciliation when the
 * app boots into a session where a prior tooltip was already applied.
 *
 * Rust side: `src-tauri/src/tray/commands.rs:tray_get_tooltip`.
 */
export async function getTrayTooltipFromRust(): Promise<string | null> {
  if (!isTauri()) return null
  try {
    const tooltip = await invoke<string | null>("tray_get_tooltip")
    return typeof tooltip === "string" ? tooltip : null
  } catch (err) {
    loggers.tray.warn("tray_get_tooltip failed", { error: String(err) })
    return null
  }
}

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
  // Use the root translator: tray menu labels in `lib/tray/defaults.ts` and
  // `lib/tray/all-commands.ts` are stored as full keys (`tray.show`,
  // `tray.allCommands`, `tray.categories.<bucket>`). Scoping to "tray" here
  // would prepend a second `tray.` segment and fail every lookup.
  const t = useTranslations() as unknown as NextIntlTranslator
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

    const resilientT = makeResilientTrayTranslator(t)
    function flush() {
      const dto = buildTrayPayload({
        items,
        t: resilientT,
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
