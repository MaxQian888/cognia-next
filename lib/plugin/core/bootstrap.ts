import { WINDOW_LABELS } from "@/lib/native/utils"

import type { PluginManagerConfig } from "./manager"

export interface ResolvePluginRuntimeBootstrapOptions {
  isTauri: boolean
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
        runtimeProfile: "browser",
        pluginDirectory: "",
        enablePython: false,
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
    },
  }
}
