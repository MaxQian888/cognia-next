/**
 * Plugin System Logger
 *
 * Centralized logging for the plugin system using the unified logger.
 */

import { createLogger, type Logger } from "@/lib/logger"
import type { PluginLogger } from "@/types/plugin"

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal"

interface LoggerOptions {
  prefix?: string
  enabled?: boolean
  minLevel?: LogLevel
}

type PluginLoggerExtended = PluginLogger & {
  trace: (message: string, ...args: unknown[]) => void
  fatal: (message: string, ...args: unknown[]) => void
  child: (scope: string) => PluginLoggerExtended
  withContext: (context: Record<string, unknown>) => PluginLoggerExtended
}

const pluginBaseLogger = createLogger("plugin")

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Error)
  )
}

function normalizeArgs(args: unknown[]): {
  error?: Error | unknown
  data?: Record<string, unknown>
} {
  if (args.length === 0) {
    return {}
  }

  let extractedError: Error | unknown
  const merged: Record<string, unknown> = {}
  const extras: unknown[] = []

  for (const arg of args) {
    if (arg instanceof Error && extractedError === undefined) {
      extractedError = arg
      continue
    }

    if (isPlainObject(arg)) {
      Object.assign(merged, arg)
      continue
    }

    extras.push(arg)
  }

  if (extras.length === 1) {
    merged.arg = extras[0]
  } else if (extras.length > 1) {
    merged.args = extras
  }

  return {
    error: extractedError,
    data: Object.keys(merged).length > 0 ? merged : undefined,
  }
}

function createLoggerWrapper(logger: Logger): PluginLoggerExtended {
  const wrapper: PluginLoggerExtended = {
    trace: (message: string, ...args: unknown[]) => {
      const { data } = normalizeArgs(args)
      logger.trace(message, data)
    },
    debug: (message: string, ...args: unknown[]) => {
      const { data } = normalizeArgs(args)
      logger.debug(message, data)
    },
    info: (message: string, ...args: unknown[]) => {
      const { data } = normalizeArgs(args)
      logger.info(message, data)
    },
    warn: (message: string, ...args: unknown[]) => {
      const { data } = normalizeArgs(args)
      logger.warn(message, data)
    },
    error: (message: string, ...args: unknown[]) => {
      const { error, data } = normalizeArgs(args)
      logger.error(message, error, data)
    },
    fatal: (message: string, ...args: unknown[]) => {
      const { error, data } = normalizeArgs(args)
      logger.fatal(message, error, data)
    },
    child: (scope: string) => createLoggerWrapper(logger.child(scope)),
    withContext: (context: Record<string, unknown>) =>
      createLoggerWrapper(logger.withContext(context)),
  }

  return wrapper
}

export function createPluginSystemLogger(
  module: string,
  _options?: LoggerOptions
): PluginLoggerExtended {
  const childLogger = pluginBaseLogger.child(module)
  return createLoggerWrapper(childLogger)
}

export const pluginLogger = createPluginSystemLogger("system")

export const loggers = {
  manager: createPluginSystemLogger("manager"),
  loader: createPluginSystemLogger("loader"),
  registry: createPluginSystemLogger("registry"),
  sandbox: createPluginSystemLogger("sandbox"),
  hooks: createPluginSystemLogger("hooks"),
  marketplace: createPluginSystemLogger("marketplace"),
  hotReload: createPluginSystemLogger("hotReload"),
  devServer: createPluginSystemLogger("devServer"),
  ipc: createPluginSystemLogger("ipc"),
  backup: createPluginSystemLogger("backup"),
  updater: createPluginSystemLogger("updater"),
  validation: createPluginSystemLogger("validation"),
  a2ui: createPluginSystemLogger("a2ui"),
  debugger: createPluginSystemLogger("debugger"),
  messageBus: createPluginSystemLogger("messageBus"),
  agent: createPluginSystemLogger("agent"),
  i18n: createPluginSystemLogger("i18n"),
  rollback: createPluginSystemLogger("rollback"),
  signature: createPluginSystemLogger("signature"),
  workflow: createPluginSystemLogger("workflow"),
  devTools: createPluginSystemLogger("devTools"),
}

export type PluginSystemLogger = ReturnType<typeof createPluginSystemLogger>
