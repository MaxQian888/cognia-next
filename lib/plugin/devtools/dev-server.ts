/**
 * Plugin Development Server
 *
 * Provides a development server for plugin development with:
 * - WebSocket communication for real-time updates
 * - Plugin bundling and serving
 * - Development tools integration
 */

import { invoke } from "@tauri-apps/api/core"
import { listen, UnlistenFn } from "@tauri-apps/api/event"
import { loggers } from "../core/logger"
import { openUrl } from "@/lib/native/opener"

// =============================================================================
// Types
// =============================================================================

export interface DevServerConfig {
  /** Server port */
  port: number
  /** Host address */
  host: string
  /** Enable HTTPS */
  https: boolean
  /** Enable source maps */
  sourceMaps: boolean
  /** Open browser on start */
  openBrowser: boolean
  /** Plugins directory */
  pluginsDir: string
  /** Enable CORS */
  cors: boolean
}

export interface DevServerStatus {
  running: boolean
  port: number
  host: string
  url: string
  startedAt?: number
  connectedClients: number
}

export interface DevServerMessage {
  type: "reload" | "update" | "error" | "log" | "inspect" | "command"
  pluginId?: string
  payload: unknown
  timestamp: number
}

export interface PluginBuildResult {
  success: boolean
  pluginId: string
  outputPath?: string
  duration: number
  errors?: string[]
  warnings?: string[]
}

export interface DevConsoleMessage {
  level: "debug" | "info" | "warn" | "error"
  pluginId: string
  message: string
  args?: unknown[]
  timestamp: number
  stack?: string
}

type MessageHandler = (message: DevServerMessage) => void
type ConsoleHandler = (message: DevConsoleMessage) => void

// =============================================================================
// Dev Server Client
// =============================================================================

export class PluginDevServer {
  private config: DevServerConfig
  private status: DevServerStatus
  private ws: WebSocket | null = null
  private messageHandlers: Set<MessageHandler> = new Set()
  private consoleHandlers: Set<ConsoleHandler> = new Set()
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 1000
  private unlistenFn: UnlistenFn | null = null
  private consoleLogs: DevConsoleMessage[] = []
  private maxConsoleLogs = 500
  private watchedPlugins: Map<string, string> = new Map()
  private commandHandlers: Map<string, Set<(args: unknown) => unknown | Promise<unknown>>> =
    new Map()
  private startListeners: Set<() => void> = new Set()
  private stopListeners: Set<() => void> = new Set()
  private errorListeners: Set<(error: Error) => void> = new Set()
  private buildListeners: Set<(result: PluginBuildResult) => void> = new Set()
  private buildHistory: PluginBuildResult[] = []

  constructor(config: Partial<DevServerConfig> = {}) {
    this.config = {
      port: 9527,
      host: "localhost",
      https: false,
      sourceMaps: true,
      openBrowser: false,
      pluginsDir: "",
      cors: true,
      ...config,
    }

    this.status = {
      running: false,
      port: this.config.port,
      host: this.config.host,
      url: this.buildUrl(),
      connectedClients: 0,
    }
  }

  // ===========================================================================
  // Server Control
  // ===========================================================================

  async start(): Promise<void> {
    if (this.status.running) {
      loggers.devServer.warn("Server is already running")
      return
    }

    try {
      // Start the dev server via Tauri
      const result = await invoke<{ port: number; host: string }>("plugin_dev_server_start", {
        config: this.config,
      })

      this.status = {
        running: true,
        port: result.port,
        host: result.host,
        url: this.buildUrl(result.host, result.port),
        startedAt: Date.now(),
        connectedClients: 0,
      }

      // Connect WebSocket for real-time communication
      await this.connectWebSocket()

      // Listen for Tauri events
      this.unlistenFn = await listen<DevServerMessage>("plugin:dev-server", (event) => {
        this.handleMessage(event.payload)
      })

      loggers.devServer.info(`Started at ${this.status.url}`)
      for (const listener of this.startListeners) {
        listener()
      }

      if (this.config.openBrowser) {
        await openUrl(this.status.url)
      }
    } catch (error) {
      loggers.devServer.error("Failed to start:", error)
      const normalized = error instanceof Error ? error : new Error(String(error))
      for (const listener of this.errorListeners) {
        listener(normalized)
      }
      throw error
    }
  }

  async stop(): Promise<void> {
    if (!this.status.running) return

    try {
      // Disconnect WebSocket
      this.disconnectWebSocket()

      // Stop listening for events
      if (this.unlistenFn) {
        this.unlistenFn()
        this.unlistenFn = null
      }

      // Stop the dev server via Tauri
      await invoke("plugin_dev_server_stop")

      this.status = {
        ...this.status,
        running: false,
        connectedClients: 0,
      }

      loggers.devServer.info("Stopped")
      for (const listener of this.stopListeners) {
        listener()
      }
    } catch (error) {
      loggers.devServer.error("Failed to stop:", error)
      const normalized = error instanceof Error ? error : new Error(String(error))
      for (const listener of this.errorListeners) {
        listener(normalized)
      }
      throw error
    }
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  // ===========================================================================
  // WebSocket Connection
  // ===========================================================================

  private async connectWebSocket(): Promise<void> {
    const wsUrl = `${this.config.https ? "wss" : "ws"}://${this.status.host}:${this.status.port}/ws`

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsUrl)

        this.ws.onopen = () => {
          loggers.devServer.info("WebSocket connected")
          this.reconnectAttempts = 0
          this.status.connectedClients = 1
          resolve()
        }

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data) as DevServerMessage
            this.handleMessage(message)
          } catch (error) {
            loggers.devServer.error("Failed to parse message:", error)
          }
        }

        this.ws.onclose = () => {
          loggers.devServer.info("WebSocket disconnected")
          this.status.connectedClients = 0
          this.attemptReconnect()
        }

        this.ws.onerror = (error) => {
          loggers.devServer.error("WebSocket error:", error)
          reject(error)
        }
      } catch (error) {
        reject(error)
      }
    })
  }

  private disconnectWebSocket(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  private attemptReconnect(): void {
    if (!this.status.running) return
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      loggers.devServer.error("Max reconnect attempts reached")
      return
    }

    this.reconnectAttempts++
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1)

    loggers.devServer.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)

    setTimeout(() => {
      this.connectWebSocket().catch(() => {
        this.attemptReconnect()
      })
    }, delay)
  }

  // ===========================================================================
  // Message Handling
  // ===========================================================================

  private handleMessage(message: DevServerMessage): void {
    switch (message.type) {
      case "log":
        this.handleLogMessage(message.payload as DevConsoleMessage)
        break

      case "error":
        loggers.devServer.error("Plugin error:", message.payload)
        break

      case "reload":
        loggers.devServer.info("Reload triggered for:", message.pluginId)
        break

      case "update":
        loggers.devServer.info("Hot update for:", message.pluginId)
        break
    }

    // Notify all handlers
    for (const handler of this.messageHandlers) {
      try {
        handler(message)
      } catch (error) {
        loggers.devServer.error("Message handler error:", error)
      }
    }
  }

  private handleLogMessage(log: DevConsoleMessage): void {
    this.consoleLogs.push(log)
    if (this.consoleLogs.length > this.maxConsoleLogs) {
      this.consoleLogs = this.consoleLogs.slice(-this.maxConsoleLogs)
    }

    // Notify console handlers
    for (const handler of this.consoleHandlers) {
      try {
        handler(log)
      } catch (error) {
        loggers.devServer.error("Console handler error:", error)
      }
    }
  }

  // ===========================================================================
  // Plugin Building
  // ===========================================================================

  async buildPlugin(pluginId: string): Promise<PluginBuildResult> {
    const startTime = Date.now()

    try {
      // invoke-parity-exempt: plugin build backend not yet shipped in Rust; caught and returned as build failure
      const result = await invoke<{
        success: boolean
        outputPath?: string
        errors?: string[]
        warnings?: string[]
      }>("plugin_build", {
        pluginId,
        config: {
          sourceMaps: this.config.sourceMaps,
          minify: false,
          target: "development",
        },
      })

      const buildResult = {
        success: result.success,
        pluginId,
        outputPath: result.outputPath,
        duration: Date.now() - startTime,
        errors: result.errors,
        warnings: result.warnings,
      }
      this.buildHistory.push(buildResult)
      for (const listener of this.buildListeners) {
        listener(buildResult)
      }
      return buildResult
    } catch (error) {
      const buildResult = {
        success: false,
        pluginId,
        duration: Date.now() - startTime,
        errors: [error instanceof Error ? error.message : String(error)],
      }
      this.buildHistory.push(buildResult)
      for (const listener of this.buildListeners) {
        listener(buildResult)
      }
      return buildResult
    }
  }

  async buildAllPlugins(): Promise<PluginBuildResult[]> {
    try {
      const pluginIds = await invoke<string[]>("plugin_list_dev_plugins", {
        pluginsDir: this.config.pluginsDir,
      })

      const results: PluginBuildResult[] = []
      for (const pluginId of pluginIds) {
        const result = await this.buildPlugin(pluginId)
        results.push(result)
      }

      return results
    } catch (error) {
      loggers.devServer.error("Failed to build all plugins:", error)
      return []
    }
  }

  // ===========================================================================
  // Commands
  // ===========================================================================

  sendCommand(command: string, pluginId?: string, data?: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      loggers.devServer.warn("WebSocket not connected")
      return
    }

    const message: DevServerMessage = {
      type: "command",
      pluginId,
      payload: { command, data },
      timestamp: Date.now(),
    }

    this.ws.send(JSON.stringify(message))
  }

  triggerReload(pluginId?: string): void {
    this.sendCommand("reload", pluginId)
  }

  triggerInspect(pluginId: string): void {
    this.sendCommand("inspect", pluginId)
  }

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  onConsoleLog(handler: ConsoleHandler): () => void {
    this.consoleHandlers.add(handler)
    return () => this.consoleHandlers.delete(handler)
  }

  // ===========================================================================
  // Getters
  // ===========================================================================

  getStatus(): DevServerStatus {
    return { ...this.status }
  }

  getConsoleLogs(pluginId?: string): DevConsoleMessage[] {
    if (pluginId) {
      return this.consoleLogs.filter((log) => log.pluginId === pluginId)
    }
    return [...this.consoleLogs]
  }

  clearConsoleLogs(pluginId?: string): void {
    if (pluginId) {
      this.consoleLogs = this.consoleLogs.filter((log) => log.pluginId !== pluginId)
    } else {
      this.consoleLogs = []
    }
  }

  isRunning(): boolean {
    return this.status.running
  }

  getUrl(): string {
    return this.status.url
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  private buildUrl(host?: string, port?: number): string {
    const protocol = this.config.https ? "https" : "http"
    const h = host || this.config.host
    const p = port || this.config.port
    return `${protocol}://${h}:${p}`
  }

  // ===========================================================================
  // Missing Methods (implied by tests)
  // ===========================================================================

  getConfig(): DevServerConfig {
    return { ...this.config }
  }

  setConfig(config: Partial<DevServerConfig>): void {
    this.config = { ...this.config, ...config }
    this.status.port = this.config.port
    this.status.host = this.config.host
    this.status.url = this.buildUrl()
  }

  async buildAll(): Promise<PluginBuildResult[]> {
    return this.buildAllPlugins()
  }

  async watchPlugin(_pluginId: string, _path: string): Promise<void> {
    try {
      await invoke("plugin_dev_server_watch", {
        pluginId: _pluginId,
        path: _path,
      })
    } catch {
      // Keep local tracking even when backend watch command is unavailable.
    }
    this.watchedPlugins.set(_pluginId, _path)
  }

  async unwatchPlugin(_pluginId: string): Promise<void> {
    try {
      await invoke("plugin_dev_server_unwatch", { pluginId: _pluginId })
    } catch {
      // Best effort in environments without backend watch support.
    }
    this.watchedPlugins.delete(_pluginId)
  }

  isWatching(_pluginId: string): boolean {
    return this.watchedPlugins.has(_pluginId)
  }

  getConnectedClients(): number {
    return this.status.connectedClients
  }

  sendMessage(event: string, payload: unknown): void {
    // Basic implementation using existing logic if possible, or stub
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: event, payload, timestamp: Date.now() }))
    }
  }

  broadcast(event: string, payload: unknown): void {
    this.sendMessage(event, payload)
  }

  onCommand(_command: string, _handler: (args: unknown) => void): () => void {
    const handlers = this.commandHandlers.get(_command) || new Set()
    handlers.add(_handler)
    this.commandHandlers.set(_command, handlers)
    return () => {
      const registered = this.commandHandlers.get(_command)
      if (!registered) return
      registered.delete(_handler)
      if (registered.size === 0) {
        this.commandHandlers.delete(_command)
      }
    }
  }

  async executeCommand(
    _command: string,
    _args: unknown
  ): Promise<{ success: boolean; result?: unknown }> {
    const handlers = Array.from(this.commandHandlers.get(_command) || [])
    if (handlers.length === 0) {
      return { success: false }
    }

    let latest: unknown
    for (const handler of handlers) {
      latest = await handler(_args)
    }

    return { success: true, result: latest }
  }

  onStart(_listener: () => void): () => void {
    this.startListeners.add(_listener)
    return () => this.startListeners.delete(_listener)
  }

  onStop(_listener: () => void): () => void {
    this.stopListeners.add(_listener)
    return () => this.stopListeners.delete(_listener)
  }

  onError(_listener: (error: Error) => void): () => void {
    this.errorListeners.add(_listener)
    return () => this.errorListeners.delete(_listener)
  }

  onBuild(_listener: (result: PluginBuildResult) => void): () => void {
    this.buildListeners.add(_listener)
    return () => this.buildListeners.delete(_listener)
  }

  getBuildHistory(_pluginId?: string): PluginBuildResult[] {
    if (_pluginId) {
      return this.buildHistory.filter((entry) => entry.pluginId === _pluginId)
    }
    return [...this.buildHistory]
  }

  clearBuildHistory(): void {
    this.buildHistory = []
  }

  getWebSocketUrl(): string {
    return `${this.config.https ? "wss" : "ws"}://${this.status.host}:${this.status.port}/ws`
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let devServerInstance: PluginDevServer | null = null

export function getPluginDevServer(config?: Partial<DevServerConfig>): PluginDevServer {
  if (!devServerInstance) {
    devServerInstance = new PluginDevServer(config)
  }
  return devServerInstance
}

export function resetPluginDevServer(): void {
  if (devServerInstance) {
    devServerInstance.stop()
    devServerInstance = null
  }
}
