/**
 * Browser console tap for the plugin devtools panel.
 *
 * The Bus tab is Tauri-only because the `PluginDevServer` over there
 * collects messages from the host. In the browser there is no
 * comparable channel — so the Logs / Bus tabs sit empty. This module
 * fills that gap by intercepting `console.{log,info,warn,error,debug}`
 * on the current window and routing each call into the existing
 * `debugLog` ring buffer (`dev-tools.ts`).
 *
 * The tap is installed at most once per page; calling `installConsoleTap`
 * a second time is a no-op (returns the existing disposer). The
 * disposer restores the original console methods and re-arms the
 * "not installed" state so a subsequent call can re-install.
 *
 * Safe in non-browser environments — bails out silently if `console`
 * isn't available.
 */

import { debugLog, isDebugEnabled, setDebugMode } from "./dev-tools"

type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug"

const LEVEL_TO_LOG: Record<ConsoleLevel, "debug" | "info" | "warn" | "error"> = {
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
  debug: "debug",
}

const LEVELS: ConsoleLevel[] = ["log", "info", "warn", "error", "debug"]

interface ConsoleLikeHost {
  log: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
}

export interface InstallConsoleTapOptions {
  /** PluginId tag attached to every captured entry. Defaults to `"browser"`. */
  pluginId?: string
  /**
   * If `true`, ensures `setDebugMode(true)` so `debugLog` actually
   * stores entries. Defaults to `true` — the tap is only useful when
   * the debug ring is recording.
   */
  enableDebugMode?: boolean
  /**
   * Override the console object — used by tests. Defaults to
   * `globalThis.console`.
   */
  consoleOverride?: ConsoleLikeHost
}

interface InstalledState {
  originals: Partial<Record<ConsoleLevel, (...args: unknown[]) => void>>
  consoleRef: ConsoleLikeHost
  pluginId: string
  debugWasEnabled: boolean
}

let installed: InstalledState | null = null

function stringify(args: unknown[]): { message: string; data: unknown } {
  if (args.length === 0) return { message: "", data: undefined }
  const [first, ...rest] = args
  const message = typeof first === "string" ? first : safeJsonish(first)
  const data = rest.length === 0 ? undefined : rest.length === 1 ? rest[0] : rest
  return { message, data }
}

function safeJsonish(value: unknown): string {
  if (value === undefined) return "undefined"
  if (value === null) return "null"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function installConsoleTap(options: InstallConsoleTapOptions = {}): () => void {
  if (installed) {
    return () => uninstallConsoleTap()
  }
  const consoleRef =
    options.consoleOverride ?? (globalThis as { console?: ConsoleLikeHost }).console
  if (!consoleRef) return () => undefined

  const pluginId = options.pluginId ?? "browser"
  const enableDebugMode = options.enableDebugMode ?? true
  const debugWasEnabled = isDebugEnabled()
  if (enableDebugMode && !debugWasEnabled) setDebugMode(true)

  const originals: InstalledState["originals"] = {}
  for (const level of LEVELS) {
    const rawOriginal = consoleRef[level]
    originals[level] = rawOriginal
    const bound = rawOriginal.bind(consoleRef)
    consoleRef[level] = ((...args: unknown[]) => {
      try {
        const { message, data } = stringify(args)
        debugLog(pluginId, LEVEL_TO_LOG[level], "console", message, data)
      } catch {
        // Never let our tap crash the host's console.
      }
      bound(...args)
    }) as typeof rawOriginal
  }

  installed = { originals, consoleRef, pluginId, debugWasEnabled }
  return () => uninstallConsoleTap()
}

export function uninstallConsoleTap(): void {
  if (!installed) return
  const { originals, consoleRef, debugWasEnabled } = installed
  for (const level of LEVELS) {
    const original = originals[level]
    if (original) consoleRef[level] = original
  }
  if (!debugWasEnabled) setDebugMode(false)
  installed = null
}

export function isConsoleTapInstalled(): boolean {
  return installed !== null
}
