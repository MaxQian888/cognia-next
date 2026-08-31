import type { PluginLogger } from "@/types/plugin/plugin"

export type PluginHostPlatform = "tauri" | "mobile" | "web" | "headless"

export interface PluginHostEnvironmentSnapshot {
  tauri: boolean
  mobile: boolean
  web: boolean
  browser: boolean
  platform: PluginHostPlatform
}

function detectPlatform(): PluginHostPlatform {
  if ((globalThis as Record<string, unknown>).__COGNIA_HEADLESS__ === true) return "headless"
  if (typeof window === "undefined") return "web"
  if ("__TAURI_INTERNALS__" in window) return "tauri"
  const capacitor = (
    window as unknown as {
      Capacitor?: { isNativePlatform?: () => boolean }
    }
  ).Capacitor
  if (capacitor?.isNativePlatform?.() === true) return "mobile"
  return "web"
}

/** Framework-free shell detection for code that runs outside `activate(ctx)`. */
export function readHostCapabilities(): PluginHostEnvironmentSnapshot {
  const platform = detectPlatform()
  return {
    tauri: platform === "tauri",
    mobile: platform === "mobile",
    web: platform === "web",
    browser: typeof window !== "undefined",
    platform,
  }
}

/** Console-backed fallback for renderers that cannot retain an activate context. */
export function createPluginLogger(pluginId: string): PluginLogger {
  const write =
    (level: "debug" | "info" | "warn" | "error") =>
    (message: string, ...args: unknown[]) =>
      console[level](`[plugin:${pluginId}] ${message}`, ...args)
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  }
}
