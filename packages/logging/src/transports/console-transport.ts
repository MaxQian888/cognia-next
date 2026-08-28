/**
 * Console Transport
 * Outputs logs to browser/Node console with colors and formatting
 */

import type { StructuredLogEntry, Transport, LogLevel } from "../types"
import { CONSOLE_BRIDGE_MODULE, getOriginalConsoleMethod } from "../console-bridge-state"

/**
 * Console color codes for different log levels
 */
const LEVEL_COLORS: Record<LogLevel, string> = {
  trace: "color: #888",
  debug: "color: #6B7280",
  info: "color: #3B82F6",
  warn: "color: #F59E0B",
  error: "color: #EF4444",
  fatal: "color: #DC2626; font-weight: bold",
}

/**
 * Console icons for different log levels
 */
const LEVEL_ICONS: Record<LogLevel, string> = {
  trace: "🔍",
  debug: "🐛",
  info: "ℹ️",
  warn: "⚠️",
  error: "❌",
  fatal: "💀",
}

/**
 * ANSI SGR sequences per level, for Node sinks. `LEVEL_COLORS` above is CSS
 * for `console.log("%c…")`, which only a DOM console understands — outside a
 * browser it renders as literal `%c` noise, so Node needs its own table.
 */
const LEVEL_ANSI: Record<LogLevel, string> = {
  trace: "\x1b[90m",
  debug: "\x1b[36m",
  info: "\x1b[34m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  fatal: "\x1b[1;31m",
}

const ANSI_RESET = "\x1b[0m"

/** How the prefix is painted: DOM `%c` CSS, terminal SGR, or not at all. */
export type ConsoleColorMode = "css" | "ansi" | "none"

/**
 * What the surrounding process can render. Injected so the resolution rules
 * below are testable without mutating globals.
 */
export interface ConsoleEnvironment {
  /** A DOM console, which renders `%c` CSS directives. */
  browser: boolean
  /** Node stdout is attached to a terminal (so SGR is safe and wanted). */
  tty: boolean
  /** `NO_COLOR` is set to anything at all. */
  noColor: boolean
  /** `FORCE_COLOR` / `CLICOLOR_FORCE` is set to anything but `0`. */
  forceColor: boolean
}

/**
 * Read the ambient environment. Guarded on both sides: `window` is absent in
 * the headless brain, and `process` is absent in a browser bundle.
 */
export function detectConsoleEnvironment(): ConsoleEnvironment {
  if (typeof window !== "undefined") {
    return { browser: true, tty: false, noColor: false, forceColor: false }
  }
  const proc = typeof process !== "undefined" ? process : undefined
  const env = proc?.env ?? {}
  const force = env.FORCE_COLOR ?? env.CLICOLOR_FORCE
  return {
    browser: false,
    tty: proc?.stdout?.isTTY === true,
    noColor: env.NO_COLOR !== undefined,
    forceColor: force !== undefined && force !== "0",
  }
}

/**
 * Console transport options
 */
export interface ConsoleTransportOptions {
  /** Use colors in output */
  useColors?: boolean
  /** Use icons in output */
  useIcons?: boolean
  /** Include timestamp */
  includeTimestamp?: boolean
  /** Include module name */
  includeModule?: boolean
  /** Include trace ID */
  includeTraceId?: boolean
  /** Compact format (single line) */
  compact?: boolean
}

const DEFAULT_OPTIONS: ConsoleTransportOptions = {
  useColors: true,
  useIcons: true,
  includeTimestamp: true,
  includeModule: true,
  includeTraceId: true,
  compact: false,
}

/**
 * A Node process whose stdout is a pipe is being supervised — on the headless
 * path that supervisor is `cognia-server`, which stamps its own clock and
 * level tag around every line it reads. Repeating them here is what produced
 * `[INFO] [brain] [3:34:42 PM] ℹ️ [INFO] [scheduler] …`, so the transport
 * yields those two columns to the sink. Explicit options still win.
 */
export function resolveConsoleTransportOptions(
  options: ConsoleTransportOptions | undefined,
  env: ConsoleEnvironment
): ConsoleTransportOptions {
  const supervised = !env.browser && !env.tty
  return {
    ...DEFAULT_OPTIONS,
    includeTimestamp: !supervised,
    useIcons: !supervised,
    ...options,
  }
}

/**
 * `useColors` is an explicit answer in BOTH directions: `false` disables
 * colour everywhere, and `true` turns it on for a sink that would not have
 * chosen it — a caller that asks for colour on a pipe is doing what
 * `FORCE_COLOR` does, and silently ignoring the option would make it a lie.
 * Left undefined, the sink decides: a DOM console gets CSS, and a terminal (or
 * an explicit `FORCE_COLOR`, which is how you keep colour in `docker logs`)
 * gets ANSI. A bare pipe gets neither.
 */
export function resolveColorMode(
  useColors: boolean | undefined,
  env: ConsoleEnvironment
): ConsoleColorMode {
  if (useColors === false) return "none"
  if (env.browser) return "css"
  // `NO_COLOR` is the environment's answer, so an explicit `true` from the
  // caller outranks it; it still beats the ambient tty/FORCE_COLOR guess.
  if (useColors === true) return "ansi"
  if (env.noColor) return "none"
  return env.forceColor || env.tty ? "ansi" : "none"
}

const consoleApi = globalThis.console

/**
 * Console transport implementation
 */
export class ConsoleTransport implements Transport {
  name = "console"
  private options: ConsoleTransportOptions
  private colorMode: ConsoleColorMode

  constructor(
    options?: ConsoleTransportOptions,
    env: ConsoleEnvironment = detectConsoleEnvironment()
  ) {
    this.options = resolveConsoleTransportOptions(options, env)
    // The CALLER's raw option, not the merged one. `DEFAULT_OPTIONS.useColors`
    // is `true` in the sense of "colour is allowed", and reading it back after
    // the merge would turn that permission into a demand — painting the
    // supervised pipe the whole `resolveConsoleTransportOptions` bare-line
    // path exists to keep plain.
    this.colorMode = resolveColorMode(options?.useColors, env)
  }

  log(entry: StructuredLogEntry): void {
    const { level, message, module, traceId, data, stack, timestamp } = entry
    // The console bridge writes the caller's own args straight to the original
    // console method before it ever reaches the logger, so printing the
    // structured entry too would show every legacy `console.warn` twice. The
    // entry still reaches storage / native / remote from here.
    if (module === CONSOLE_BRIDGE_MODULE) return
    const opts = this.options

    // Build prefix parts
    const parts: string[] = []

    if (opts.includeTimestamp) {
      const time = new Date(timestamp).toLocaleTimeString()
      parts.push(`[${time}]`)
    }

    if (opts.useIcons) {
      parts.push(LEVEL_ICONS[level])
    }

    parts.push(`[${level.toUpperCase()}]`)

    if (opts.includeModule && module) {
      parts.push(`[${module}]`)
    }

    if (opts.includeTraceId && traceId) {
      parts.push(`[${traceId.slice(0, 8)}]`)
    }

    const prefix = parts.join(" ")
    const consoleMethod = this.getConsoleMethod(level)
    const extra = opts.compact || !data ? [] : [data]

    // Only the prefix is painted; the message stays readable when the output
    // is later grepped or re-wrapped by a supervisor.
    switch (this.colorMode) {
      case "css":
        consoleMethod(`%c${prefix} ${message}`, LEVEL_COLORS[level], ...extra)
        break
      case "ansi":
        consoleMethod(`${LEVEL_ANSI[level]}${prefix}${ANSI_RESET} ${message}`, ...extra)
        break
      default:
        consoleMethod(`${prefix} ${message}`, ...extra)
    }

    // Output stack trace separately
    if (stack) {
      consoleApi.debug(stack)
    }
  }

  private getConsoleMethod(level: LogLevel): (...args: unknown[]) => void {
    switch (level) {
      case "trace":
        return getOriginalConsoleMethod(consoleApi, "trace")
      case "debug":
        return getOriginalConsoleMethod(consoleApi, "debug")
      case "info":
        return getOriginalConsoleMethod(consoleApi, "info")
      case "warn":
        return getOriginalConsoleMethod(consoleApi, "warn")
      case "error":
      case "fatal":
        return getOriginalConsoleMethod(consoleApi, "error")
      default:
        return getOriginalConsoleMethod(consoleApi, "log")
    }
  }
}

/**
 * Create a console transport with default options
 */
export function createConsoleTransport(
  options?: ConsoleTransportOptions,
  env?: ConsoleEnvironment
): ConsoleTransport {
  return new ConsoleTransport(options, env)
}
