/**
 * Read a third-party adapter against the adapter core (ADR-0217).
 *
 * Plugin adapters are loaded at runtime (JavaScript factories, Python
 * proxies) and type-checked by nobody. The host, however, calls the core
 * members unconditionally, so a plugin without `getSessions` or `cancel` used
 * to crash the manager mid-turn. `adaptPluginProtocolAdapter` fixes the shape
 * once, when the adapter is created:
 *
 * - members the host cannot stand in for (`connect`, `disconnect`,
 *   `createSession`, `closeSession`, `prompt`) must exist, otherwise creation
 *   fails with {@link ExternalAgentAdapterContractError};
 * - bookkeeping the host can do honestly is supplied when missing: the
 *   session registry (from the sessions this wrapper created), connection
 *   state, `execute` (folded from `prompt`), and `healthCheck` (connection
 *   state, as the base adapter answers it);
 * - operations only the agent can perform (`cancel`, `respondToPermission`)
 *   throw {@link ExternalAgentUnsupportedOperationError} when missing rather
 *   than pretending to succeed;
 * - every other member the plugin provides (optional capabilities, vendor
 *   methods, `semantics`) passes through unchanged, so capability guards see
 *   exactly what the plugin implements.
 */

import {
  ExternalAgentAdapterContractError,
  ExternalAgentUnsupportedOperationError,
  type ProtocolAdapter,
  type SessionCreateOptions,
} from "@cognia/agent-contracts/adapter"
import type {
  AcpCapabilities,
  AcpPermissionResponse,
  AcpToolInfo,
  ExternalAgentConfig,
  ExternalAgentConnectionStatus,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentMessage,
  ExternalAgentResult,
  ExternalAgentSession,
} from "@cognia/agent-contracts/external-agent"
import type { ExternalAgentSessionInputQueue } from "@cognia/agent-contracts/session-operations"
import { BaseProtocolAdapter } from "./base-adapter"

/** Members a plugin adapter must implement itself. */
export const PLUGIN_ADAPTER_REQUIRED_METHODS = [
  "connect",
  "disconnect",
  "createSession",
  "closeSession",
  "prompt",
] as const

type RawAdapter = Record<string, unknown>

function method<T extends (...args: never[]) => unknown>(
  raw: RawAdapter,
  name: string
): T | undefined {
  const value = raw[name]
  return typeof value === "function" ? (value.bind(raw) as T) : undefined
}

/** The core, completed where the host can do so honestly. */
class PluginAdapterCore extends BaseProtocolAdapter {
  readonly protocol: string
  /** Ids the host asked the adapter to forget when the plugin cannot forget itself. */
  private readonly forgotten = new Set<string>()

  constructor(
    private readonly raw: RawAdapter,
    protocol: string
  ) {
    super()
    this.protocol = protocol
  }

  override get connectionStatus(): ExternalAgentConnectionStatus {
    const own = this.raw.connectionStatus
    return typeof own === "string" ? (own as ExternalAgentConnectionStatus) : this._connectionStatus
  }

  override get capabilities(): AcpCapabilities | undefined {
    return (this.raw.capabilities as AcpCapabilities | undefined) ?? this._capabilities
  }

  override get tools(): AcpToolInfo[] | undefined {
    return (this.raw.tools as AcpToolInfo[] | undefined) ?? this._tools
  }

  async connect(config: ExternalAgentConfig): Promise<void> {
    this._connectionStatus = "connecting"
    try {
      await method<(c: ExternalAgentConfig) => Promise<void>>(this.raw, "connect")!(config)
    } catch (error) {
      this._connectionStatus = "error"
      throw error
    }
    this._config = config
    this._connectionStatus = "connected"
  }

  async disconnect(): Promise<void> {
    await method<() => Promise<void>>(this.raw, "disconnect")!()
    this._connectionStatus = "disconnected"
    this._sessions.clear()
    this.forgotten.clear()
  }

  override isConnected(): boolean {
    const own = method<() => boolean>(this.raw, "isConnected")
    return own ? own() : this._connectionStatus === "connected"
  }

  async createSession(options?: SessionCreateOptions): Promise<ExternalAgentSession> {
    const session = await method<(o?: SessionCreateOptions) => Promise<ExternalAgentSession>>(
      this.raw,
      "createSession"
    )!(options)
    this.forgotten.delete(session.id)
    this._sessions.set(session.id, session)
    return session
  }

  async closeSession(sessionId: string): Promise<void> {
    await method<(id: string) => Promise<void>>(this.raw, "closeSession")!(sessionId)
    this._sessions.delete(sessionId)
  }

  prompt(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent> {
    return method<
      (
        id: string,
        m: ExternalAgentMessage,
        o?: ExternalAgentExecutionOptions
      ) => AsyncIterable<ExternalAgentEvent>
    >(this.raw, "prompt")!(sessionId, message, options)
  }

  override async execute(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): Promise<ExternalAgentResult> {
    const own = method<
      (
        id: string,
        m: ExternalAgentMessage,
        o?: ExternalAgentExecutionOptions
      ) => Promise<ExternalAgentResult>
    >(this.raw, "execute")
    return own ? own(sessionId, message, options) : super.execute(sessionId, message, options)
  }

  async respondToPermission(sessionId: string, response: AcpPermissionResponse): Promise<void> {
    const own = method<(id: string, r: AcpPermissionResponse) => Promise<void>>(
      this.raw,
      "respondToPermission"
    )
    if (!own)
      throw new ExternalAgentUnsupportedOperationError(this.protocol, "permission responses")
    await own(sessionId, response)
  }

  async cancel(sessionId: string): Promise<void | ExternalAgentSessionInputQueue> {
    const own = method<(id: string) => Promise<void | ExternalAgentSessionInputQueue>>(
      this.raw,
      "cancel"
    )
    if (!own) throw new ExternalAgentUnsupportedOperationError(this.protocol, "cancel")
    return own(sessionId)
  }

  override getSession(sessionId: string): ExternalAgentSession | undefined {
    if (this.forgotten.has(sessionId)) return undefined
    const own = method<(id: string) => ExternalAgentSession | undefined>(this.raw, "getSession")
    return own ? own(sessionId) : this._sessions.get(sessionId)
  }

  override getSessions(): ExternalAgentSession[] {
    const own = method<() => ExternalAgentSession[]>(this.raw, "getSessions")
    const sessions = own ? own() : Array.from(this._sessions.values())
    return sessions.filter((session) => !this.forgotten.has(session.id))
  }

  override forgetSessions(): void {
    const own = method<() => void>(this.raw, "forgetSessions")
    if (own) own()
    else for (const session of this.getSessions()) this.forgotten.add(session.id)
    this._sessions.clear()
  }

  override async healthCheck(): Promise<boolean> {
    const own = method<() => Promise<boolean>>(this.raw, "healthCheck")
    return own ? own() : this.isConnected()
  }
}

const CORE_MEMBERS = new Set<PropertyKey>([
  "protocol",
  "connectionStatus",
  "capabilities",
  "tools",
  "connect",
  "disconnect",
  "isConnected",
  "createSession",
  "closeSession",
  "prompt",
  "execute",
  "respondToPermission",
  "cancel",
  "getSession",
  "getSessions",
  "forgetSessions",
  "healthCheck",
])

/**
 * Wrap a plugin adapter so it satisfies the adapter core. Throws
 * {@link ExternalAgentAdapterContractError} when a required member is missing.
 */
export function adaptPluginProtocolAdapter(candidate: unknown, protocol: string): ProtocolAdapter {
  if (!candidate || typeof candidate !== "object") {
    throw new ExternalAgentAdapterContractError(protocol, [...PLUGIN_ADAPTER_REQUIRED_METHODS])
  }
  const raw = candidate as RawAdapter
  const missing = PLUGIN_ADAPTER_REQUIRED_METHODS.filter((name) => typeof raw[name] !== "function")
  if (missing.length > 0) throw new ExternalAgentAdapterContractError(protocol, missing)
  const core = new PluginAdapterCore(raw, protocol)
  return new Proxy(core, {
    get(target, property) {
      if (CORE_MEMBERS.has(property) || !(property in raw)) {
        const value = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      }
      const value = raw[property as string]
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(raw) : value
    },
    has(target, property) {
      return CORE_MEMBERS.has(property) || property in raw || property in target
    },
  }) as unknown as ProtocolAdapter
}
