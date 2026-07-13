/**
 * Log Level Types
 * Unified log level definitions for the cognia logging system.
 */

// Legacy type surface (originally lived in `@/types/system/logger` in Cognia).
// Inlined here so the unified-logger package is self-contained.
export type AppLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal"

/**
 * Extended log levels with trace support
 */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal"

export type LogRuntime = "browser" | "server" | "tauri" | "mcp" | "plugin" | "internal" | "unknown"

export type LogOrigin =
  "frontend" | "web-runtime" | "tauri" | "mcp" | "plugin" | "diagnostic" | "unknown"

/**
 * Log level priority mapping (higher = more severe)
 */
export const LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
}

/**
 * Legacy priority map (alias of LEVEL_PRIORITY, kept for backward compat).
 */
export const LOG_LEVEL_PRIORITY: Record<AppLogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
}
