/**
 * Plugin System Logger
 *
 * Centralized logging for the plugin system using the unified logger.
 */

import { createLogger, type Logger } from "@/lib/logging"
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

// Lazy base logger.
//
// `@/lib/plugin/core/logger` is pulled in early by the plugin manager,
// validators, and a few stores. Several import chains in those packages
// (notably `stores/agent/agent-team-store/slices/actions.slice` →
// `agent-team-compat` → orchestrator → hooks-system → plugin store →
// plugin index → validation → THIS file) re-enter the module graph
// while `@/lib/logging` is still being evaluated under Jest's CJS loader.
// Calling `createLogger("plugin")` at module-init time during that
// window resolves to an empty namespace and throws
// `createLogger is not a function`. Resolving lazily on first use keeps
// the runtime fully implemented while breaking the init-order cycle.
let pluginBaseLoggerInstance: Logger | undefined
function getPluginBaseLogger(): Logger {
  if (!pluginBaseLoggerInstance) {
    pluginBaseLoggerInstance = createLogger("plugin")
  }
  return pluginBaseLoggerInstance
}

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
  const childLogger = getPluginBaseLogger().child(module)
  return createLoggerWrapper(childLogger)
}

/**
 * Build a logger map whose entries materialise on first access via
 * `Object.defineProperty` getters. Each entry is then a stable plain object
 * (so `jest.spyOn(loggers.manager, "info")` works as expected) while
 * module-init importers don't trigger `createLogger("plugin")` against the
 * still-evaluating `@/lib/logging` barrel.
 */
function makeLazyLoggers<K extends string>(...modules: K[]): Record<K, PluginLoggerExtended> {
  const cache: Partial<Record<K, PluginLoggerExtended>> = {}
  const out = {} as Record<K, PluginLoggerExtended>
  for (const mod of modules) {
    Object.defineProperty(out, mod, {
      enumerable: true,
      configurable: true,
      get(): PluginLoggerExtended {
        if (!cache[mod]) {
          cache[mod] = createPluginSystemLogger(mod)
        }
        return cache[mod] as PluginLoggerExtended
      },
    })
  }
  return out
}

// `pluginLogger` retains the historical default-export shape but defers the
// underlying `createLogger("plugin")` invocation until the consumer touches
// a property. We attach a getter for each level so spy / mock tooling can
// rebind methods on the resolved instance directly.
let _pluginLoggerSingleton: PluginLoggerExtended | undefined
const PLUGIN_LOGGER_METHODS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "child",
  "withContext",
] as const

function getPluginLoggerSingleton(): PluginLoggerExtended {
  if (!_pluginLoggerSingleton) {
    _pluginLoggerSingleton = createPluginSystemLogger("system")
  }
  return _pluginLoggerSingleton
}

export const pluginLogger = {} as PluginLoggerExtended
for (const method of PLUGIN_LOGGER_METHODS) {
  Object.defineProperty(pluginLogger, method, {
    enumerable: true,
    configurable: true,
    get() {
      const target = getPluginLoggerSingleton() as unknown as Record<string, unknown>
      const fn = target[method]
      return typeof fn === "function" ? (fn as (...args: unknown[]) => unknown).bind(target) : fn
    },
  })
}

export const loggers = makeLazyLoggers(
  "manager",
  "loader",
  "registry",
  "sandbox",
  "hooks",
  "marketplace",
  "hotReload",
  "devServer",
  "ipc",
  "backup",
  "updater",
  "validation",
  "a2ui",
  "debugger",
  "messageBus",
  "agent",
  "i18n",
  "rollback",
  "signature",
  "workflow",
  "devTools"
)

export type PluginSystemLogger = ReturnType<typeof createPluginSystemLogger>
