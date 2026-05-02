/**
 * Plugin IPC (Inter-Plugin Communication)
 *
 * Enables secure communication between plugins through:
 * - Direct messaging between plugins
 * - Broadcast messaging to all plugins
 * - RPC-style method calls
 * - Typed event subscriptions
 */

import type { PluginPermission } from "@/types/plugin"
import { loggers } from "../core/logger"

// =============================================================================
// Types
// =============================================================================

export interface IPCMessage {
  id: string
  type: "request" | "response" | "broadcast" | "event"
  channel: string
  senderId: string
  targetId?: string
  payload: unknown
  timestamp: number
  replyTo?: string
}

export interface IPCRequest {
  id: string
  method: string
  args: unknown[]
  timeout: number
}

export interface IPCResponse {
  id: string
  success: boolean
  result?: unknown
  error?: string
}

export interface IPCSubscription {
  channel: string
  pluginId: string
  handler: (data: unknown, senderId: string) => void
  filter?: (senderId: string) => boolean
}

export interface ExposedMethod {
  name: string
  pluginId: string
  handler: (...args: unknown[]) => unknown | Promise<unknown>
  description?: string
  schema?: Record<string, unknown>
}

export interface IPCConfig {
  defaultTimeout: number
  maxMessageSize: number
  enableLogging: boolean
  requirePermission: boolean
}

type MessageHandler = (data: unknown, senderId: string) => void
type ResponseHandler = (response: IPCResponse) => void

// =============================================================================
// Plugin IPC Manager
// =============================================================================

export class PluginIPC {
  private config: IPCConfig
  private subscriptions: Map<string, Set<IPCSubscription>> = new Map()
  private exposedMethods: Map<string, Map<string, ExposedMethod>> = new Map()
  private pendingRequests: Map<string, ResponseHandler> = new Map()
  private messageHistory: IPCMessage[] = []
  private maxHistory = 100
  private pluginPermissions: Map<string, Set<PluginPermission>> = new Map()

  constructor(config: Partial<IPCConfig> = {}) {
    this.config = {
      defaultTimeout: 30000,
      maxMessageSize: 1024 * 1024, // 1MB
      enableLogging: false,
      requirePermission: false,
      ...config,
    }
  }

  // ===========================================================================
  // Plugin Registration
  // ===========================================================================

  registerPlugin(pluginId: string, permissions: PluginPermission[] = []): void {
    this.pluginPermissions.set(pluginId, new Set(permissions))
    this.exposedMethods.set(pluginId, new Map())
  }

  unregisterPlugin(pluginId: string): void {
    // Remove all subscriptions for this plugin
    for (const [channel, subs] of this.subscriptions.entries()) {
      for (const sub of subs) {
        if (sub.pluginId === pluginId) {
          subs.delete(sub)
        }
      }
      if (subs.size === 0) {
        this.subscriptions.delete(channel)
      }
    }

    // Remove exposed methods
    this.exposedMethods.delete(pluginId)

    // Remove permissions
    this.pluginPermissions.delete(pluginId)
  }

  // ===========================================================================
  // Direct Messaging
  // ===========================================================================

  async send(senderId: string, targetId: string, channel: string, data: unknown): Promise<void> {
    this.validateMessage(data)

    const message: IPCMessage = {
      id: this.generateId(),
      type: "request",
      channel,
      senderId,
      targetId,
      payload: data,
      timestamp: Date.now(),
    }

    this.recordMessage(message)
    this.log("send", message)

    // Deliver to target plugin's subscriptions
    const subs = this.subscriptions.get(channel)
    if (subs) {
      for (const sub of subs) {
        if (sub.pluginId === targetId) {
          if (!sub.filter || sub.filter(senderId)) {
            try {
              sub.handler(data, senderId)
            } catch (error) {
              loggers.manager.error(`[IPC] Handler error in ${targetId}:`, error)
            }
          }
        }
      }
    }
  }

  async sendAndWait<T>(
    senderId: string,
    targetId: string,
    channel: string,
    data: unknown,
    timeout?: number
  ): Promise<T> {
    const requestId = this.generateId()
    const timeoutMs = timeout || this.config.defaultTimeout

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error(`IPC request to ${targetId} timed out`))
      }, timeoutMs)

      this.pendingRequests.set(requestId, (response) => {
        clearTimeout(timer)
        this.pendingRequests.delete(requestId)

        if (response.success) {
          resolve(response.result as T)
        } else {
          reject(new Error(response.error || "Unknown error"))
        }
      })

      const message: IPCMessage = {
        id: requestId,
        type: "request",
        channel,
        senderId,
        targetId,
        payload: data,
        timestamp: Date.now(),
      }

      this.recordMessage(message)
      this.deliverMessage(message)
    })
  }

  respond(pluginId: string, requestId: string, result: unknown, error?: string): void {
    const response: IPCResponse = {
      id: requestId,
      success: !error,
      result,
      error,
    }

    const handler = this.pendingRequests.get(requestId)
    if (handler) {
      handler(response)
    }

    const message: IPCMessage = {
      id: this.generateId(),
      type: "response",
      channel: "__response__",
      senderId: pluginId,
      payload: response,
      timestamp: Date.now(),
      replyTo: requestId,
    }

    this.recordMessage(message)
  }

  // ===========================================================================
  // Broadcasting
  // ===========================================================================

  broadcast(senderId: string, channel: string, data: unknown): void {
    this.validateMessage(data)

    const message: IPCMessage = {
      id: this.generateId(),
      type: "broadcast",
      channel,
      senderId,
      payload: data,
      timestamp: Date.now(),
    }

    this.recordMessage(message)
    this.log("broadcast", message)

    // Deliver to all subscribers except sender
    const subs = this.subscriptions.get(channel)
    if (subs) {
      for (const sub of subs) {
        if (sub.pluginId !== senderId) {
          if (!sub.filter || sub.filter(senderId)) {
            try {
              sub.handler(data, senderId)
            } catch (error) {
              loggers.manager.error(`[IPC] Broadcast handler error in ${sub.pluginId}:`, error)
            }
          }
        }
      }
    }
  }

  // ===========================================================================
  // Subscriptions
  // ===========================================================================

  subscribe(
    pluginId: string,
    channel: string,
    handler: MessageHandler,
    filter?: (senderId: string) => boolean
  ): () => void {
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set())
    }

    const subscription: IPCSubscription = {
      channel,
      pluginId,
      handler,
      filter,
    }

    this.subscriptions.get(channel)!.add(subscription)

    // Return unsubscribe function
    return () => {
      const subs = this.subscriptions.get(channel)
      if (subs) {
        subs.delete(subscription)
        if (subs.size === 0) {
          this.subscriptions.delete(channel)
        }
      }
    }
  }

  unsubscribe(pluginId: string, channel?: string): void {
    if (channel) {
      const subs = this.subscriptions.get(channel)
      if (subs) {
        for (const sub of subs) {
          if (sub.pluginId === pluginId) {
            subs.delete(sub)
          }
        }
      }
    } else {
      // Unsubscribe from all channels
      for (const subs of this.subscriptions.values()) {
        for (const sub of subs) {
          if (sub.pluginId === pluginId) {
            subs.delete(sub)
          }
        }
      }
    }
  }

  // ===========================================================================
  // RPC (Remote Procedure Call)
  // ===========================================================================

  expose(
    pluginId: string,
    methods: Record<string, (...args: unknown[]) => unknown | Promise<unknown>>
  ): void {
    const methodMap = this.exposedMethods.get(pluginId) || new Map()

    for (const [name, handler] of Object.entries(methods)) {
      methodMap.set(name, {
        name,
        pluginId,
        handler,
      })
    }

    this.exposedMethods.set(pluginId, methodMap)
  }

  unexpose(pluginId: string, methodName?: string): void {
    if (methodName) {
      this.exposedMethods.get(pluginId)?.delete(methodName)
    } else {
      this.exposedMethods.delete(pluginId)
    }
  }

  async call<T>(
    callerId: string,
    targetPluginId: string,
    methodName: string,
    ...args: unknown[]
  ): Promise<T> {
    const methodMap = this.exposedMethods.get(targetPluginId)
    if (!methodMap) {
      throw new Error(`Plugin ${targetPluginId} has no exposed methods`)
    }

    const method = methodMap.get(methodName)
    if (!method) {
      throw new Error(`Method ${methodName} not found in plugin ${targetPluginId}`)
    }

    this.log("call", { callerId, targetPluginId, methodName, args })

    try {
      const result = await method.handler(...args)
      return result as T
    } catch (error) {
      throw new Error(
        `RPC call to ${targetPluginId}.${methodName} failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  getExposedMethods(pluginId: string): string[] {
    const methodMap = this.exposedMethods.get(pluginId)
    if (!methodMap) return []
    return Array.from(methodMap.keys())
  }

  getAllExposedMethods(): Map<string, string[]> {
    const result = new Map<string, string[]>()
    for (const [pluginId, methodMap] of this.exposedMethods.entries()) {
      result.set(pluginId, Array.from(methodMap.keys()))
    }
    return result
  }

  // ===========================================================================
  // Message Delivery
  // ===========================================================================

  private deliverMessage(message: IPCMessage): void {
    if (message.targetId) {
      // Direct message
      const subs = this.subscriptions.get(message.channel)
      if (subs) {
        for (const sub of subs) {
          if (sub.pluginId === message.targetId) {
            if (!sub.filter || sub.filter(message.senderId)) {
              try {
                sub.handler(message.payload, message.senderId)
              } catch (error) {
                loggers.manager.error(`[IPC] Delivery error to ${message.targetId}:`, error)
              }
            }
          }
        }
      }
    }
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
  }

  private validateMessage(data: unknown): void {
    const size = JSON.stringify(data).length
    if (size > this.config.maxMessageSize) {
      throw new Error(`Message size ${size} exceeds maximum ${this.config.maxMessageSize}`)
    }
  }

  private recordMessage(message: IPCMessage): void {
    this.messageHistory.push(message)
    if (this.messageHistory.length > this.maxHistory) {
      this.messageHistory = this.messageHistory.slice(-this.maxHistory)
    }
  }

  private log(action: string, data: unknown): void {
    if (this.config.enableLogging) {
      loggers.manager.debug(`[IPC] ${action}:`, data)
    }
  }

  // ===========================================================================
  // Introspection
  // ===========================================================================

  getMessageHistory(options?: {
    channel?: string
    pluginId?: string
    limit?: number
  }): IPCMessage[] {
    let messages = [...this.messageHistory]

    if (options?.channel) {
      messages = messages.filter((m) => m.channel === options.channel)
    }

    if (options?.pluginId) {
      messages = messages.filter(
        (m) => m.senderId === options.pluginId || m.targetId === options.pluginId
      )
    }

    if (options?.limit) {
      messages = messages.slice(-options.limit)
    }

    return messages
  }

  getSubscriptions(pluginId?: string): Map<string, string[]> {
    const result = new Map<string, string[]>()

    for (const [channel, subs] of this.subscriptions.entries()) {
      const subscribers = Array.from(subs)
        .filter((s) => !pluginId || s.pluginId === pluginId)
        .map((s) => s.pluginId)

      if (subscribers.length > 0) {
        result.set(channel, subscribers)
      }
    }

    return result
  }

  getStats(): {
    totalSubscriptions: number
    totalExposedMethods: number
    pendingRequests: number
    messageCount: number
  } {
    let totalSubscriptions = 0
    for (const subs of this.subscriptions.values()) {
      totalSubscriptions += subs.size
    }

    let totalExposedMethods = 0
    for (const methods of this.exposedMethods.values()) {
      totalExposedMethods += methods.size
    }

    return {
      totalSubscriptions,
      totalExposedMethods,
      pendingRequests: this.pendingRequests.size,
      messageCount: this.messageHistory.length,
    }
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  clear(): void {
    this.subscriptions.clear()
    this.exposedMethods.clear()
    this.pendingRequests.clear()
    this.messageHistory = []
    this.pluginPermissions.clear()
  }

  clearHistory(): void {
    this.messageHistory = []
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let ipcInstance: PluginIPC | null = null

export function getPluginIPC(config?: Partial<IPCConfig>): PluginIPC {
  if (!ipcInstance) {
    ipcInstance = new PluginIPC(config)
  }
  return ipcInstance
}

export function resetPluginIPC(): void {
  if (ipcInstance) {
    ipcInstance.clear()
    ipcInstance = null
  }
}

// =============================================================================
// Context API Factory
// =============================================================================

export interface PluginIPCAPI {
  send: (targetPluginId: string, channel: string, data: unknown) => Promise<void>
  sendAndWait: <T>(
    targetPluginId: string,
    channel: string,
    data: unknown,
    timeout?: number
  ) => Promise<T>
  broadcast: (channel: string, data: unknown) => void
  on: (channel: string, handler: (data: unknown, senderId: string) => void) => () => void
  expose: (methods: Record<string, (...args: unknown[]) => unknown | Promise<unknown>>) => void
  call: <T>(targetPluginId: string, method: string, ...args: unknown[]) => Promise<T>
  getExposedMethods: (pluginId: string) => string[]
}

export function createIPCAPI(pluginId: string): PluginIPCAPI {
  const ipc = getPluginIPC()

  return {
    send: (targetPluginId, channel, data) => ipc.send(pluginId, targetPluginId, channel, data),
    sendAndWait: <T>(targetPluginId: string, channel: string, data: unknown, timeout?: number) =>
      ipc.sendAndWait<T>(pluginId, targetPluginId, channel, data, timeout),
    broadcast: (channel, data) => ipc.broadcast(pluginId, channel, data),
    on: (channel, handler) => ipc.subscribe(pluginId, channel, handler),
    expose: (methods) => ipc.expose(pluginId, methods),
    call: <T>(targetPluginId: string, method: string, ...args: unknown[]) =>
      ipc.call<T>(pluginId, targetPluginId, method, ...args),
    getExposedMethods: (targetPluginId) => ipc.getExposedMethods(targetPluginId),
  }
}
