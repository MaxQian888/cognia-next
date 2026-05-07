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
 *      `proxy_config` module via the `proxy_set` Tauri command so reqwest
 *      clients see the change without re-reading Dexie. Called by the
 *      settings store after every successful save and at boot.
 */

import { invoke } from "@tauri-apps/api/core"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { isTauri } from "@/lib/tauri"
import { buildProxyUrl, isProxyActive } from "@/lib/network/proxy-config"
import { loggers } from "@/lib/logger"
import { DEFAULT_NETWORK_PROXY_SETTINGS, type NetworkProxySettings } from "@/types/network/proxy"

const log = loggers.network

// ---------------------------------------------------------------------------
// Legacy ProxyConfig shape (consumed by proxy-fetch.ts).
// ---------------------------------------------------------------------------

export interface ProxyManualCredentials {
  username?: string
  password?: string
}

export interface ProxyConfig {
  enabled: boolean
  mode: "system" | "manual" | "off"
  url: string | null
  host?: string | null
  port?: number | null
  protocol?: string | null
  manual?: ProxyManualCredentials | null
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
    manual:
      cfg.username && cfg.password ? { username: cfg.username, password: cfg.password } : null,
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
 * setter. Cheap to call repeatedly — short-circuits when the serialized
 * payload hasn't changed since the last push. No-op outside Tauri.
 */
export async function applyProxyToRust(cfg?: NetworkProxySettings | null): Promise<void> {
  if (!isTauri()) return
  const settings = cfg ?? getNetworkProxy()
  const payload = {
    mode: settings.mode,
    protocol: settings.protocol,
    host: settings.host,
    port: settings.port,
    username: settings.username ?? null,
    password: settings.password ?? null,
    bypass: settings.bypass,
    proxy_websockets: settings.proxyWebsockets,
  }
  const serialized = JSON.stringify(payload)
  if (serialized === lastPushedSerialized) return
  try {
    await invoke("proxy_set", { cfg: payload })
    lastPushedSerialized = serialized
    if (isProxyActive(settings)) {
      log.debug(
        `Pushed proxy config to Rust: ${settings.protocol}://${settings.host}:${settings.port}`
      )
    } else {
      log.debug("Pushed empty proxy config to Rust")
    }
  } catch (err) {
    log.warn(`Failed to push proxy config to Rust: ${String(err)}`)
  }
}

/** Test-only — clears the dedupe cache so subsequent applyProxyToRust pushes. */
export function resetApplyProxyDedupeForTesting(): void {
  lastPushedSerialized = null
}
