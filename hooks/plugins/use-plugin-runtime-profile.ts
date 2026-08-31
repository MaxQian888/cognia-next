"use client"

/**
 * The runtime profile the plugin manager is actually running as, for UI that
 * has to say what this host can and cannot run.
 *
 * Reads the SAME rule the manager boots from (`pluginRuntimeProfileFor`), so a
 * compatibility badge cannot claim one thing while the manager enforces
 * another.
 *
 * `useSyncExternalStore`'s server snapshot is `"browser"`: this app is a static
 * export, so the build-time render has no Tauri bridge and no Capacitor shell.
 * The profile never changes while the page is open, so `subscribe` has nothing
 * to listen for.
 */

import { useSyncExternalStore } from "react"

import { pluginRuntimeProfileFor } from "@/lib/plugin/core/bootstrap"
import { isNativeMobile, isTauri } from "@/lib/platform/detect"
import type { PluginRuntimeProfile } from "@/types/plugin"

const NEVER_CHANGES = () => () => {}
const getServerSnapshot = (): PluginRuntimeProfile => "browser"
const getSnapshot = (): PluginRuntimeProfile =>
  pluginRuntimeProfileFor({ isTauri: isTauri(), isMobile: isNativeMobile() })

export function usePluginRuntimeProfile(): PluginRuntimeProfile {
  return useSyncExternalStore(NEVER_CHANGES, getSnapshot, getServerSnapshot)
}
