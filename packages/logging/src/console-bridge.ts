import { createLogger } from "./core"
import {
  CONSOLE_BRIDGE_MODULE,
  CONSOLE_BRIDGE_ORIGINALS,
  type ConsoleBridgeOriginals,
} from "./console-bridge-state"
import type { Logger } from "./types"

interface ConsoleBridgeTarget {
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export interface InstallConsoleBridgeOptions {
  console?: ConsoleBridgeTarget
  logger?: Logger
}

interface InstalledBridge {
  cleanup: () => void
}

const installedBridges = new WeakMap<object, InstalledBridge>()

/**
 * Route legacy `console.warn` / `console.error` calls through the unified logger.
 * The re-entry guard lets console-like transports write through the original
 * methods without recursively creating another log entry.
 */
export function installConsoleBridge(options: InstallConsoleBridgeOptions = {}): () => void {
  const target = options.console ?? (typeof window !== "undefined" ? globalThis.console : undefined)
  if (!target) return () => {}

  const existing = installedBridges.get(target)
  if (existing) return existing.cleanup

  const logger = options.logger ?? createLogger(CONSOLE_BRIDGE_MODULE)
  const originalWarn = target.warn
  const originalError = target.error
  let forwarding = false

  const forward = (level: "warn" | "error", args: unknown[]): void => {
    const original = level === "warn" ? originalWarn : originalError
    // The original ALWAYS runs, and runs first.
    //
    // This bridge is an addition to the console, not a replacement for it. The
    // logger can drop an entry for reasons that have nothing to do with the
    // caller — no console transport attached yet (this installs pre-hydration,
    // before `bootstrapLogger()`), the console transport switched off, a
    // per-module `minLevel` above the call, or the sampler. Every one of those
    // used to turn a `console.error` into silence, which is exactly the wrong
    // outcome for the startup crashes this window contains.
    original.apply(target, args)
    if (forwarding) return

    forwarding = true
    try {
      const [first, ...rest] = args
      const message = typeof first === "string" ? first : `Console ${level}`
      const values = typeof first === "string" ? rest : args
      if (level === "warn") {
        logger.warn(message, values.length > 0 ? { arguments: values } : undefined)
        return
      }

      const errorIndex = values.findIndex((value) => value instanceof Error)
      const error = errorIndex >= 0 ? (values[errorIndex] as Error) : undefined
      const remaining = errorIndex >= 0 ? values.filter((_, index) => index !== errorIndex) : values
      logger.error(message, error, remaining.length > 0 ? { arguments: remaining } : undefined)
    } finally {
      forwarding = false
    }
  }

  const bridgedWarn = (...args: unknown[]) => forward("warn", args)
  const bridgedError = (...args: unknown[]) => forward("error", args)
  Object.defineProperty(target, CONSOLE_BRIDGE_ORIGINALS, {
    configurable: true,
    value: { warn: originalWarn, error: originalError } satisfies ConsoleBridgeOriginals,
  })
  target.warn = bridgedWarn
  target.error = bridgedError

  const cleanup = (): void => {
    if (target.warn === bridgedWarn) target.warn = originalWarn
    if (target.error === bridgedError) target.error = originalError
    delete (
      target as ConsoleBridgeTarget & { [CONSOLE_BRIDGE_ORIGINALS]?: ConsoleBridgeOriginals }
    )[CONSOLE_BRIDGE_ORIGINALS]
    installedBridges.delete(target)
  }
  installedBridges.set(target, { cleanup })
  return cleanup
}
