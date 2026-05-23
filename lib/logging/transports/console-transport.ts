/**
 * Console Transport
 * Outputs logs to browser/Node console with colors and formatting
 */

import type { StructuredLogEntry, Transport, LogLevel } from "@/types/logging"

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

const consoleApi = globalThis.console

/**
 * Console transport implementation
 */
export class ConsoleTransport implements Transport {
  name = "console"
  private options: ConsoleTransportOptions

  constructor(options?: ConsoleTransportOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  log(entry: StructuredLogEntry): void {
    const { level, message, module, traceId, data, stack, timestamp } = entry
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

    // Output based on format
    if (opts.compact || !data) {
      if (opts.useColors && typeof window !== "undefined") {
        consoleMethod(`%c${prefix} ${message}`, LEVEL_COLORS[level])
      } else {
        consoleMethod(`${prefix} ${message}`)
      }
    } else {
      if (opts.useColors && typeof window !== "undefined") {
        consoleMethod(`%c${prefix} ${message}`, LEVEL_COLORS[level], data)
      } else {
        consoleMethod(`${prefix} ${message}`, data)
      }
    }

    // Output stack trace separately
    if (stack) {
      consoleApi.debug(stack)
    }
  }

  private getConsoleMethod(level: LogLevel): (...args: unknown[]) => void {
    switch (level) {
      case "trace":
        return consoleApi.trace.bind(consoleApi)
      case "debug":
        return consoleApi.debug.bind(consoleApi)
      case "info":
        return consoleApi.info.bind(consoleApi)
      case "warn":
        return consoleApi.warn.bind(consoleApi)
      case "error":
      case "fatal":
        return consoleApi.error.bind(consoleApi)
      default:
        return consoleApi.log.bind(consoleApi)
    }
  }
}

/**
 * Create a console transport with default options
 */
export function createConsoleTransport(options?: ConsoleTransportOptions): ConsoleTransport {
  return new ConsoleTransport(options)
}
