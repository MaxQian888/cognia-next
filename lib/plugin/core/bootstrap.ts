import { WINDOW_LABELS } from "@/lib/native/utils"

import type { PluginManagerConfig } from "./manager"

export interface ResolvePluginRuntimeBootstrapOptions {
  isTauri: boolean
  /**
   * True when running inside the Capacitor mobile (WebView) shell. Mutually
   * exclusive with `isTauri` (Tauri wins if both were somehow set). Selects the
   * `mobile` runtime profile so the manager loads only mobile-supported
   * built-ins instead of treating the WebView as a desktop browser.
   */
  isMobile?: boolean
  windowLabel: string | null
  pluginDirectory?: string
}

type PluginBootstrapResolution =
  | {
      shouldInitialize: true
      config: PluginManagerConfig
    }
  | {
      shouldInitialize: false
      reason: "non-main-window" | "missing-plugin-directory"
    }

export function resolvePluginRuntimeBootstrap(
  options: ResolvePluginRuntimeBootstrapOptions
): PluginBootstrapResolution {
  if (!options.isTauri) {
    return {
      shouldInitialize: true,
      config: {
        // Capacitor mobile is a browser-class WebView without the Tauri bridge.
        // It boots the `mobile` profile so desktop-native built-ins stay
        // discovered-but-inert; plain web (and the Node CLI) stays `browser`.
        runtimeProfile: options.isMobile ? "mobile" : "browser",
        pluginDirectory: "",
        enablePython: false,
        lifecycleFeatures: {
          ledgerV2: true,
          runtimeServices: true,
          scopedRealms: false,
        },
      },
    }
  }

  if (options.windowLabel && options.windowLabel !== WINDOW_LABELS.MAIN) {
    return {
      shouldInitialize: false,
      reason: "non-main-window",
    }
  }

  if (!options.pluginDirectory) {
    return {
      shouldInitialize: false,
      reason: "missing-plugin-directory",
    }
  }

  return {
    shouldInitialize: true,
    config: {
      runtimeProfile: "tauri",
      pluginDirectory: options.pluginDirectory,
      enablePython: true,
      lifecycleFeatures: {
        ledgerV2: true,
        runtimeServices: true,
        scopedRealms: false,
      },
    },
  }
}
