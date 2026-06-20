/**
 * Demo external-agent protocol adapter — reference implementation for the
 * `external-agent-adapter` capability.
 *
 * This is a self-contained "echo" adapter that does NOT spawn a real
 * subprocess: it exists to demonstrate the contribution seam (a plugin shipping
 * a `() => ProtocolAdapter` factory that the host lazy-imports on enable and
 * registers into the external-agent `protocolAdapterRegistry`). A production
 * adapter would speak a real wire protocol over the generic Rust process layer;
 * the contract it implements is identical.
 */

import {
  BaseProtocolAdapter,
  type ProtocolAdapter,
  type ProtocolAdapterFactory,
  type SessionCreateOptions,
} from "@/lib/ai/agent/external/protocol-adapter"
import type {
  AcpPermissionResponse,
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentMessage,
  ExternalAgentSession,
} from "@/types/agent/external-agent"

/** The bare adapter id; the bridge registers it as `${pluginId}:demo-echo`. */
export const DEMO_ADAPTER_ID = "demo-echo"

class DemoEchoAdapter extends BaseProtocolAdapter {
  readonly protocol = DEMO_ADAPTER_ID

  async connect(config: ExternalAgentConfig): Promise<void> {
    this._config = config
    this._connectionStatus = "connected"
  }

  async disconnect(): Promise<void> {
    this._connectionStatus = "disconnected"
    this._sessions.clear()
  }

  async createSession(options?: SessionCreateOptions): Promise<ExternalAgentSession> {
    const now = new Date()
    const session: ExternalAgentSession = {
      id: this.generateSessionId(),
      agentId: this._config?.id ?? "demo",
      status: "active",
      permissionMode: options?.permissionMode === "plan" ? "plan" : "default",
      createdAt: now,
      lastActivityAt: now,
    }
    this._sessions.set(session.id, session)
    return session
  }

  async closeSession(sessionId: string): Promise<void> {
    this._sessions.delete(sessionId)
  }

  async *prompt(
    sessionId: string,
    message: ExternalAgentMessage,
    _options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent> {
    const prompt = message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("")
    yield {
      type: "message_delta",
      sessionId,
      timestamp: new Date(),
      delta: { type: "text", text: `echo: ${prompt}` },
    }
    yield {
      type: "done",
      sessionId,
      timestamp: new Date(),
      success: true,
    }
  }

  async respondToPermission(_sessionId: string, _response: AcpPermissionResponse): Promise<void> {
    // The echo adapter never requests permissions.
  }

  async cancel(_sessionId: string): Promise<void> {
    // Nothing to cancel — prompt() resolves synchronously per turn.
  }
}

/** Factory contributed via `manifest.externalAgentAdapters[].export`. */
export const createDemoEchoAdapter: ProtocolAdapterFactory = (): ProtocolAdapter =>
  new DemoEchoAdapter()
