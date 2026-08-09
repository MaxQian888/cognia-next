"use client"

/**
 * Network proxy store — derives a `ProxyConfig` snapshot from
 * `useSettingsStore`'s `networkProxy` field on demand. There is no separate
 * persistent store: the source of truth is the singleton `AppSettings` row
 * in Dexie, written via `useSettingsStore.save({ networkProxy: ... })`.
 *
 * Two shapes are exposed:
 *
 *   1. `useProxyStore` — a Zustand-shaped accessor (`getState()` +
 *      `subscribe()`) that `lib/network/proxy-fetch.ts` already wires
 *      against. Backwards-compatible with the legacy stub at
 *      `stores/system/index.ts`.
 *
 *   2. `applyProxyToRust(cfg)` — pushes the latest config into the Rust
 *      `proxy_config` module via the `proxy_apply` Tauri command so reqwest
 *      clients see the change without re-reading Dexie. Called by the
 *      settings store after every successful save and at boot.
 */

import { invoke } from "@tauri-apps/api/core"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { isTauri } from "@/lib/tauri"
import { isMainAppWindow } from "@/lib/pet/window-role"
import { buildProxyUrl, isProxyActive } from "@/lib/network/proxy-config"
import { notifyNetworkProxyApplied } from "@/lib/network/proxy-events"
import {
  applyProxyPasswordMutation,
  migrateLegacyProxyPassword,
  type ProxyPasswordMutation,
} from "@/lib/network/proxy-credentials"
import { loggers } from "@cognia/logging"
import {
  DEFAULT_NETWORK_PROXY_SETTINGS,
  type LegacyNetworkProxySettings,
  type NetworkProxySettings,
  type ProxyCandidate,
  type ProxyRuntimeStatus,
} from "@/types/network/proxy"

const log = loggers.network

// ---------------------------------------------------------------------------
// Legacy ProxyConfig shape (consumed by proxy-fetch.ts).
// ---------------------------------------------------------------------------

export interface ProxyConfig {
  enabled: boolean
  mode: "system" | "manual" | "off"
  url: string | null
  host?: string | null
  port?: number | null
  protocol?: string | null
}

export interface ProxyStoreState {
  config: ProxyConfig
}

/**
 * Project the new `NetworkProxySettings` onto the legacy `ProxyConfig`
 * shape. `auto` collapses to `"manual"` once host/port are populated — both
 * code paths behave identically downstream.
 */
function deriveLegacyConfig(np?: NetworkProxySettings | null): ProxyConfig {
  const cfg = np ?? DEFAULT_NETWORK_PROXY_SETTINGS
  const url = buildProxyUrl(cfg)
  const enabled = url !== null
  return {
    enabled,
    mode: enabled ? "manual" : "off",
    url,
    host: cfg.host || null,
    port: cfg.port || null,
    protocol: cfg.protocol || null,
  }
}

// ---------------------------------------------------------------------------
// `useProxyStore` — Zustand-shaped accessor delegating to settings store.
// ---------------------------------------------------------------------------

type Listener = (state: ProxyStoreState) => void

type UseProxyStoreFn = (() => ProxyStoreState) & {
  getState: () => ProxyStoreState
  subscribe: (listener: Listener) => () => void
}

function snapshot(): ProxyStoreState {
  return { config: deriveLegacyConfig(useSettingsStore.getState().settings?.networkProxy) }
}

const useProxyStoreImpl = (() => snapshot()) as UseProxyStoreFn
useProxyStoreImpl.getState = snapshot
useProxyStoreImpl.subscribe = (listener) =>
  useSettingsStore.subscribe((state, prev) => {
    if (state.settings?.networkProxy !== prev.settings?.networkProxy) {
      listener(snapshot())
    }
  })

export const useProxyStore: UseProxyStoreFn = useProxyStoreImpl

/**
 * Return the active proxy URL (or null when disabled). Accepts an optional
 * snapshot to avoid a second store lookup when the caller already grabbed
 * one — same signature as the legacy stub.
 */
export function getActiveProxyUrl(state?: ProxyStoreState): string | null {
  if (state) return state.config.url
  return useProxyStore.getState().config.url
}

// ---------------------------------------------------------------------------
// React hook + helpers consumed by the settings UI.
// ---------------------------------------------------------------------------

/** React hook returning the typed `NetworkProxySettings` (with defaults). */
export function useNetworkProxy(): NetworkProxySettings {
  const stored = useSettingsStore((s) => s.settings?.networkProxy)
  return stored ?? DEFAULT_NETWORK_PROXY_SETTINGS
}

/** Non-hook accessor — for IPC plumbing & tests. */
export function getNetworkProxy(): NetworkProxySettings {
  return useSettingsStore.getState().settings?.networkProxy ?? DEFAULT_NETWORK_PROXY_SETTINGS
}

// ---------------------------------------------------------------------------
// Push to Rust — keeps `proxy_config::current()` in sync with the UI.
// ---------------------------------------------------------------------------

let lastPushedSerialized: string | null = null

/**
 * Send the latest proxy config to the Rust `proxy_config::set_current`
 * apply command. Cheap to call repeatedly — short-circuits when the serialized
 * payload hasn't changed since the last push. No-op outside Tauri and in
 * least-privilege secondary windows, where process-level proxy commands are
 * intentionally unavailable.
 */
export async function applyProxyToRust(cfg?: NetworkProxySettings | null): Promise<void> {
  if (!isTauri() || !isMainAppWindow()) return
  const source = (cfg ?? getNetworkProxy()) as LegacyNetworkProxySettings
  const migration = await migrateLegacyProxyPassword(source)
  const settings = migration.settings
  const payload = {
    mode: settings.mode,
    protocol: settings.protocol,
    host: settings.host,
    port: settings.port,
    username: settings.username ?? null,
    bypass: settings.bypass,
    proxy_websockets: settings.proxyWebsockets,
  }
  const serialized = JSON.stringify(payload)
  if (serialized === lastPushedSerialized) return
  await invoke("proxy_apply", { input: payload })
  lastPushedSerialized = serialized
  notifyNetworkProxyApplied()

  if (migration.migrated) {
    // Persist the sanitized row only after both keyring verification and the
    // atomic native apply succeed. The recursive apply triggered by `save` is
    // deduped by the marker above.
    await useSettingsStore.getState().save({ networkProxy: settings })
  }

  if (isProxyActive(settings)) {
    log.debug(`Applied proxy endpoint ${settings.protocol}://${settings.host}:${settings.port}`)
  } else {
    log.debug("Applied explicit direct network policy")
  }
}

/** Update only the keyring-backed password, then atomically rebuild native state. */
export async function updateProxyPassword(mutation: ProxyPasswordMutation): Promise<boolean> {
  if (!isTauri() || !isMainAppWindow()) return false
  const configured = await applyProxyPasswordMutation(mutation)
  lastPushedSerialized = null
  await applyProxyToRust()
  return configured
}

/** Read sanitized native state for the settings UI and diagnostics. */
export async function getProxyRuntimeStatus(): Promise<ProxyRuntimeStatus> {
  if (!isTauri() || !isMainAppWindow()) {
    return { state: "ready", credentialConfigured: false }
  }
  return invoke<ProxyRuntimeStatus>("proxy_get_active")
}

/** Test-only — clears the dedupe cache so subsequent applyProxyToRust pushes. */
export function resetApplyProxyDedupeForTesting(): void {
  lastPushedSerialized = null
}

// ---------------------------------------------------------------------------
// Startup auto-detect — makes `mode: "auto"` a live setting, not a label.
// ---------------------------------------------------------------------------

/**
 * When the persisted proxy mode is `auto`, re-run local detection at boot and
 * adopt the top candidate if its host/port differs from what's stored. Proxy
 * clients (Clash, V2Ray, …) can pick a different port between launches, so an
 * `auto` config that was pinned once would otherwise silently break.
 *
 * No-op outside Tauri, in least-privilege secondary windows, when mode isn't
 * `auto`, or when detection finds nothing (the previously-stored host is left
 * untouched rather than wiped). Never throws — a failed probe just leaves the
 * config as-is.
 */
export async function maybeAutoDetectProxy(): Promise<void> {
  if (!isTauri() || !isMainAppWindow()) return
  const cfg = getNetworkProxy()
  if (cfg.mode !== "auto") return
  try {
    const candidates = await invoke<ProxyCandidate[]>("proxy_detect")
    const best = candidates?.find((candidate) => candidate.verified === true)
    if (!best) return
    if (best.host === cfg.host && best.port === cfg.port) return
    const next: NetworkProxySettings = {
      ...cfg,
      protocol: best.kind === "socks5" ? "socks5" : "http",
      host: best.host,
      port: best.port,
      lastDetectedAt: Date.now(),
    }
    await useSettingsStore.getState().save({ networkProxy: next })
    log.debug(`Auto-detect adopted proxy ${best.host}:${best.port}`)
  } catch (err) {
    log.warn(`Auto-detect failed: ${String(err)}`)
  }
}
