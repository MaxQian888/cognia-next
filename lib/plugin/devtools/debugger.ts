/**
 * Plugin Debugger
 *
 * Runtime debugging tools for plugin development including:
 * - Breakpoints and step execution
 * - State inspection
 * - Call stack tracing
 * - Live logging
 */

import type { PluginContext } from "@/types/plugin"
import { loggers } from "../core/logger"

// =============================================================================
// Types
// =============================================================================

export interface DebugSession {
  id: string
  pluginId: string
  startedAt: Date
  status: "active" | "paused" | "stopped"
  breakpoints: Breakpoint[]
  callStack: CallFrame[]
  watchExpressions: WatchExpression[]
}

export interface Breakpoint {
  id: string
  location: string
  condition?: string
  enabled: boolean
  hitCount: number
}

export interface CallFrame {
  id: string
  functionName: string
  location: string
  arguments: Record<string, unknown>
  locals: Record<string, unknown>
  timestamp: number
}

export interface WatchExpression {
  id: string
  expression: string
  value: unknown
  error?: string
  lastUpdated: number
}

export interface LogEntry {
  id: string
  pluginId: string
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
  maxCallStackDepth: number
  captureArgs: boolean
  captureLocals: boolean
  autoStart: boolean
}

type LogHandler = (entry: LogEntry) => void
type BreakHandler = (session: DebugSession, frame: CallFrame) => void

// =============================================================================
// Plugin Debugger
// =============================================================================

export class PluginDebugger {
  private config: DebuggerConfig
  private sessions: Map<string, DebugSession> = new Map()
  private logs: Map<string, LogEntry[]> = new Map()
  private logHandlers: Set<LogHandler> = new Set()
  private breakHandlers: Set<BreakHandler> = new Set()
  private globalBreakpoints: Breakpoint[] = []

  constructor(config: Partial<DebuggerConfig> = {}) {
    this.config = {
      enabled: true,
      maxLogEntries: 1000,
      maxCallStackDepth: 50,
      captureArgs: true,
      captureLocals: false,
      autoStart: false,
      ...config,
    }
  }

  // ===========================================================================
  // Session Management
  // ===========================================================================

  startSession(pluginId: string): DebugSession {
    const session: DebugSession = {
      id: this.generateId(),
      pluginId,
      startedAt: new Date(),
      status: "active",
      breakpoints: [...this.globalBreakpoints],
      callStack: [],
      watchExpressions: [],
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

  pauseSession(pluginId: string): void {
    const session = this.sessions.get(pluginId)
    if (session) {
      session.status = "paused"
    }
  }

  resumeSession(pluginId: string): void {
    const session = this.sessions.get(pluginId)
    if (session) {
      session.status = "active"
    }
  }

  // ===========================================================================
  // Breakpoints
  // ===========================================================================

  addBreakpoint(pluginId: string, location: string, condition?: string): Breakpoint {
    const breakpoint: Breakpoint = {
      id: this.generateId(),
      location,
      condition,
      enabled: true,
      hitCount: 0,
    }

    const session = this.sessions.get(pluginId)
    if (session) {
      session.breakpoints.push(breakpoint)
    } else {
      this.globalBreakpoints.push(breakpoint)
    }

    return breakpoint
  }

  removeBreakpoint(pluginId: string, breakpointId: string): void {
    const session = this.sessions.get(pluginId)
    if (session) {
      session.breakpoints = session.breakpoints.filter((bp) => bp.id !== breakpointId)
    }
    this.globalBreakpoints = this.globalBreakpoints.filter((bp) => bp.id !== breakpointId)
  }

  toggleBreakpoint(pluginId: string, breakpointId: string): void {
    const session = this.sessions.get(pluginId)
    const breakpoints = session?.breakpoints || this.globalBreakpoints
    const bp = breakpoints.find((b) => b.id === breakpointId)
    if (bp) {
      bp.enabled = !bp.enabled
    }
  }

  clearBreakpoints(pluginId?: string): void {
    if (pluginId) {
      const session = this.sessions.get(pluginId)
      if (session) {
        session.breakpoints = []
      }
    } else {
      this.globalBreakpoints = []
      for (const session of this.sessions.values()) {
        session.breakpoints = []
      }
    }
  }

  // ===========================================================================
  // Call Stack
  // ===========================================================================

  pushFrame(
    pluginId: string,
    functionName: string,
    location: string,
    args: Record<string, unknown> = {}
  ): CallFrame {
    const session = this.sessions.get(pluginId)
    if (!session || session.status !== "active") {
      return { id: "", functionName, location, arguments: {}, locals: {}, timestamp: Date.now() }
    }

    const frame: CallFrame = {
      id: this.generateId(),
      functionName,
      location,
      arguments: this.config.captureArgs ? (this.safeClone(args) as Record<string, unknown>) : {},
      locals: {},
      timestamp: Date.now(),
    }

    session.callStack.push(frame)

    // Trim if exceeds max depth
    if (session.callStack.length > this.config.maxCallStackDepth) {
      session.callStack.shift()
    }

    // Check breakpoints
    this.checkBreakpoints(session, frame)

    return frame
  }

  popFrame(pluginId: string): CallFrame | undefined {
    const session = this.sessions.get(pluginId)
    if (!session) return undefined

    return session.callStack.pop()
  }

  updateLocals(pluginId: string, frameId: string, locals: Record<string, unknown>): void {
    if (!this.config.captureLocals) return

    const session = this.sessions.get(pluginId)
    if (!session) return

    const frame = session.callStack.find((f) => f.id === frameId)
    if (frame) {
      frame.locals = this.safeClone(locals) as Record<string, unknown>
    }
  }

  getCallStack(pluginId: string): CallFrame[] {
    return this.sessions.get(pluginId)?.callStack || []
  }

  // ===========================================================================
  // Watch Expressions
  // ===========================================================================

  addWatch(pluginId: string, expression: string): WatchExpression {
    const watch: WatchExpression = {
      id: this.generateId(),
      expression,
      value: undefined,
      lastUpdated: Date.now(),
    }

    const session = this.sessions.get(pluginId)
    if (session) {
      session.watchExpressions.push(watch)
    }

    return watch
  }

  removeWatch(pluginId: string, watchId: string): void {
    const session = this.sessions.get(pluginId)
    if (session) {
      session.watchExpressions = session.watchExpressions.filter((w) => w.id !== watchId)
    }
  }

  evaluateWatch(pluginId: string, watchId: string, context: Record<string, unknown>): void {
    const session = this.sessions.get(pluginId)
    if (!session) return

    const watch = session.watchExpressions.find((w) => w.id === watchId)
    if (!watch) return

    try {
      // Safe evaluation using Function constructor with limited scope
      const fn = new Function(...Object.keys(context), `return (${watch.expression})`)
      watch.value = fn(...Object.values(context))
      watch.error = undefined
    } catch (error) {
      watch.value = undefined
      watch.error = error instanceof Error ? error.message : String(error)
    }

    watch.lastUpdated = Date.now()
  }

  evaluateAllWatches(pluginId: string, context: Record<string, unknown>): void {
    const session = this.sessions.get(pluginId)
    if (!session) return

    for (const watch of session.watchExpressions) {
      this.evaluateWatch(pluginId, watch.id, context)
    }
  }

  // ===========================================================================
  // Logging
  // ===========================================================================

  log(pluginId: string, level: LogEntry["level"], message: string, ...args: unknown[]): void {
    if (!this.config.enabled) return

    const entry: LogEntry = {
      id: this.generateId(),
      pluginId,
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

  getLogs(pluginId: string, options?: { level?: LogEntry["level"]; limit?: number }): LogEntry[] {
    let logs = this.logs.get(pluginId) || []

    if (options?.level) {
      logs = logs.filter((l) => l.level === options.level)
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

  onBreak(handler: BreakHandler): () => void {
    this.breakHandlers.add(handler)
    return () => this.breakHandlers.delete(handler)
  }

  // ===========================================================================
  // Breakpoint Checking
  // ===========================================================================

  private checkBreakpoints(session: DebugSession, frame: CallFrame): void {
    for (const bp of session.breakpoints) {
      if (!bp.enabled) continue
      if (!this.matchesLocation(frame.location, bp.location)) continue

      // Check condition if any
      if (bp.condition) {
        try {
          const fn = new Function(...Object.keys(frame.arguments), `return (${bp.condition})`)
          if (!fn(...Object.values(frame.arguments))) continue
        } catch {
          continue
        }
      }

      bp.hitCount++
      session.status = "paused"

      // Notify handlers
      for (const handler of this.breakHandlers) {
        try {
          handler(session, frame)
        } catch (err) {
          loggers.devTools.error("[Debugger] Break handler error:", err)
        }
      }

      break
    }
  }

  private matchesLocation(actual: string, pattern: string): boolean {
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$")
      return regex.test(actual)
    }
    return actual === pattern || actual.includes(pattern)
  }

  // ===========================================================================
  // Context Factory
  // ===========================================================================

  createDebugContext(pluginId: string, baseContext: PluginContext): PluginContext {
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
    this.globalBreakpoints = []
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
