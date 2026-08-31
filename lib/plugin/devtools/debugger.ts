/**
 * Per-plugin, per-generation log ring for plugin authors.
 *
 * `createDebugContext` wraps `ctx.logger` so everything a plugin logs through
 * the host logger is also kept here, tagged with the lifecycle generation it
 * came from. The DevTools Dev Session workbench reads it back filtered to the
 * generation an activation was actually verified at, so a stale line from a
 * previous load cannot be mistaken for output from the build you just made.
 *
 * It used to also carry breakpoints, a call stack and watch expressions. None
 * of it had a caller: `addBreakpoint`, `pushFrame`, `popFrame`, `addWatch`,
 * `evaluateWatch` and `onBreak` were never invoked outside their own tests, so
 * the "debugger" was a log buffer wearing a debugger's API. Real breakpoints
 * need an inspector this app does not attach, and the condition evaluator
 * built a `new Function` from a user string to decide whether to break, which
 * is a code-injection surface that nothing could ever reach on purpose.
 */

import type { PluginBaseContext } from "@/types/plugin"
import { loggers } from "../core/logger"

// =============================================================================
// Types
// =============================================================================

export interface DebugSession {
  id: string
  pluginId: string
  generation: number
  startedAt: Date
  status: "active" | "stopped"
}

export interface LogEntry {
  id: string
  pluginId: string
  generation: number
  level: "debug" | "info" | "warn" | "error"
  message: string
  args: unknown[]
  timestamp: number
  source?: string
  stack?: string
}

export interface DebuggerConfig {
  enabled: boolean
  maxLogEntries: number
}

type LogHandler = (entry: LogEntry) => void

// =============================================================================
// Plugin Debugger
// =============================================================================

export class PluginDebugger {
  private config: DebuggerConfig
  private sessions: Map<string, DebugSession> = new Map()
  private logs: Map<string, LogEntry[]> = new Map()
  private logHandlers: Set<LogHandler> = new Set()

  constructor(config: Partial<DebuggerConfig> = {}) {
    this.config = {
      enabled: true,
      maxLogEntries: 1000,
      ...config,
    }
  }

  // ===========================================================================
  // Session Management
  // ===========================================================================

  startSession(pluginId: string, generation = 0): DebugSession {
    const session: DebugSession = {
      id: this.generateId(),
      pluginId,
      generation,
      startedAt: new Date(),
      status: "active",
    }

    this.sessions.set(pluginId, session)
    this.logs.set(pluginId, [])

    return session
  }

  stopSession(pluginId: string): void {
    this.sessions.delete(pluginId)
  }

  getSession(pluginId: string): DebugSession | undefined {
    return this.sessions.get(pluginId)
  }

  // ===========================================================================
  // Logging
  // ===========================================================================

  log(pluginId: string, level: LogEntry["level"], message: string, ...args: unknown[]): void {
    if (!this.config.enabled) return

    const entry: LogEntry = {
      id: this.generateId(),
      pluginId,
      generation: this.sessions.get(pluginId)?.generation ?? 0,
      level,
      message,
      args: this.safeClone(args) as unknown[],
      timestamp: Date.now(),
    }

    // Capture stack for errors
    if (level === "error") {
      entry.stack = new Error().stack
    }

    // Store log
    let pluginLogs = this.logs.get(pluginId)
    if (!pluginLogs) {
      pluginLogs = []
      this.logs.set(pluginId, pluginLogs)
    }

    pluginLogs.push(entry)

    // Trim if exceeds max
    if (pluginLogs.length > this.config.maxLogEntries) {
      pluginLogs.shift()
    }

    // Notify handlers
    for (const handler of this.logHandlers) {
      try {
        handler(entry)
      } catch (err) {
        loggers.devTools.error("[Debugger] Log handler error:", err)
      }
    }
  }

  getLogs(
    pluginId: string,
    options?: { level?: LogEntry["level"]; generation?: number; limit?: number }
  ): LogEntry[] {
    let logs = this.logs.get(pluginId) || []

    if (options?.level) {
      logs = logs.filter((l) => l.level === options.level)
    }

    if (options?.generation !== undefined) {
      logs = logs.filter((log) => log.generation === options.generation)
    }

    if (options?.limit) {
      logs = logs.slice(-options.limit)
    }

    return logs
  }

  clearLogs(pluginId?: string): void {
    if (pluginId) {
      this.logs.delete(pluginId)
    } else {
      this.logs.clear()
    }
  }

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  onLog(handler: LogHandler): () => void {
    this.logHandlers.add(handler)
    return () => this.logHandlers.delete(handler)
  }

  // ===========================================================================
  // Context Factory
  // ===========================================================================

  createDebugContext(pluginId: string, baseContext: PluginBaseContext): PluginBaseContext {
    // Wrap logger with debug logging using arrow functions to preserve 'this'
    const wrappedLogger = {
      debug: (msg: string, ...args: unknown[]) => {
        this.log(pluginId, "debug", msg, ...args)
        baseContext.logger.debug(msg, ...args)
      },
      info: (msg: string, ...args: unknown[]) => {
        this.log(pluginId, "info", msg, ...args)
        baseContext.logger.info(msg, ...args)
      },
      warn: (msg: string, ...args: unknown[]) => {
        this.log(pluginId, "warn", msg, ...args)
        baseContext.logger.warn(msg, ...args)
      },
      error: (msg: string, ...args: unknown[]) => {
        this.log(pluginId, "error", msg, ...args)
        baseContext.logger.error(msg, ...args)
      },
    }

    return {
      ...baseContext,
      logger: wrappedLogger,
    }
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  private generateId(): string {
    return `dbg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  private safeClone(obj: unknown): unknown {
    try {
      return JSON.parse(JSON.stringify(obj))
    } catch {
      return String(obj)
    }
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled
  }

  isEnabled(): boolean {
    return this.config.enabled
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  clear(): void {
    this.sessions.clear()
    this.logs.clear()
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let debuggerInstance: PluginDebugger | null = null

export function getPluginDebugger(config?: Partial<DebuggerConfig>): PluginDebugger {
  if (!debuggerInstance) {
    debuggerInstance = new PluginDebugger(config)
  }
  return debuggerInstance
}

export function resetPluginDebugger(): void {
  if (debuggerInstance) {
    debuggerInstance.clear()
    debuggerInstance = null
  }
}
