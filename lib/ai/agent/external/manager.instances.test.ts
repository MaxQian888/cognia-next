/**
 * Several configurations of one runtime (ADR-0216): what the manager does per
 * configuration at launch, at session creation and when a permission request
 * arrives. The broad manager behaviour lives in `manager.test.ts`.
 */

jest.mock("./runtimes/dsh/dsh-managed-launch", () => ({
  prepareDshManagedLaunch: async (config: unknown) => config,
}))
jest.mock("@/lib/native/external-agent", () => ({
  checkExternalAgentCommandExists: jest.fn().mockResolvedValue(true),
  onExternalAgentExit: jest.fn(async () => () => {}),
}))
jest.mock("./config/installed-runtimes", () => ({ detectInstalledRuntimes: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/ai/agent/recovery/canonical-log", () => ({
  appendCanonicalEnvelopes: jest.fn(async () => 1),
}))

import { ExternalAgentManager } from "./manager"
import { protocolAdapterRegistry } from "./protocol-adapter"
import { ExternalAgentLifecycleError } from "@/types/agent/external-agent-lifecycle"
import type {
  AcpPermissionResponse,
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentSession,
} from "@/types/agent/external-agent"

class InstanceMockAdapter {
  readonly protocol = "mock"
  capabilities = {} as never
  tools = [] as never
  sessions = new Map<string, ExternalAgentSession>()
  events: ExternalAgentEvent[] = []
  connectedWith: ExternalAgentConfig | null = null
  responses: Array<{ sessionId: string; response: AcpPermissionResponse }> = []
  private connected = false
  private next = 0

  isConnected() {
    return this.connected
  }
  get connectionStatus() {
    return this.connected ? "connected" : "disconnected"
  }
  async connect(config: ExternalAgentConfig) {
    this.connectedWith = config
    this.connected = true
  }
  async disconnect() {
    this.connected = false
  }
  async healthCheck() {
    return this.connected
  }
  async createSession(): Promise<ExternalAgentSession> {
    this.next += 1
    const id = `s_${this.next}`
    const session = {
      id,
      agentId: "agent-1",
      status: "active",
      createdAt: new Date(),
      lastActivityAt: new Date(Date.UTC(2026, 0, this.next)),
      messages: [],
      permissionMode: "default",
    } as ExternalAgentSession
    this.sessions.set(id, session)
    return session
  }
  async closeSession(id: string) {
    this.sessions.delete(id)
  }
  getSession(id: string) {
    return this.sessions.get(id)
  }
  getSessions() {
    return Array.from(this.sessions.values())
  }
  async *prompt(): AsyncIterable<ExternalAgentEvent> {
    for (const event of this.events) yield event
  }
  async respondToPermission(sessionId: string, response: AcpPermissionResponse) {
    this.responses.push({ sessionId, response })
  }
  getSessionExtensionSupport() {
    return {
      "session/list": { state: "unknown" },
      "session/fork": { state: "unknown" },
      "session/resume": { state: "unknown" },
    }
  }
  clearSessionExtensionSupportCache() {}
}

let adapter: InstanceMockAdapter

function config(overrides: Partial<ExternalAgentConfig> = {}): ExternalAgentConfig {
  return {
    id: "agent-1",
    name: "Codex",
    protocol: "acp",
    transport: "http",
    network: { endpoint: "http://127.0.0.1:1" },
    enabled: true,
    defaultPermissionMode: "default",
    timeout: 1000,
    metadata: {},
    retryConfig: {
      maxRetries: 0,
      retryDelay: 0,
      exponentialBackoff: false,
      maxRetryDelay: 0,
      retryOnErrors: [],
    },
    ...overrides,
  } as ExternalAgentConfig
}

function freshManager(): ExternalAgentManager {
  const manager = ExternalAgentManager.getInstance({ healthCheckInterval: 0 })
  protocolAdapterRegistry.register("acp", () => adapter as never)
  return manager
}

beforeEach(() => {
  ExternalAgentManager.resetInstance()
  adapter = new InstanceMockAdapter()
})

afterEach(async () => {
  await ExternalAgentManager.getInstance({ healthCheckInterval: 0 }).dispose()
  ExternalAgentManager.resetInstance()
})

describe("launch preparation", () => {
  it("hands every adapter the prepared configuration, whatever route added it", async () => {
    const manager = freshManager()
    const preparer = jest.fn(async (input: ExternalAgentConfig) => ({
      ...input,
      network: { ...input.network!, apiKey: "sk-own" },
    }))
    manager.setLaunchPreparer(preparer)

    await manager.addAgent(config())

    expect(preparer).toHaveBeenCalledWith(expect.objectContaining({ id: "agent-1" }))
    expect(adapter.connectedWith?.network?.apiKey).toBe("sk-own")
    expect(manager.getAgent("agent-1")?.config.network?.apiKey).toBe("sk-own")
  })

  it("refuses to register a configuration whose preparation fails", async () => {
    const manager = freshManager()
    manager.setLaunchPreparer(async () => {
      throw new ExternalAgentLifecycleError("credential_missing", "gone", { slot: "apiKey" })
    })
    await expect(manager.addAgent(config())).rejects.toMatchObject({
      code: "credential_missing",
    })
    expect(manager.getAgent("agent-1")).toBeUndefined()
  })
})

describe("maxConcurrentSessions", () => {
  async function connectedManager(limit?: number) {
    const manager = freshManager()
    manager.setLaunchPreparer(async (input) => input)
    await manager.addAgent(config({ maxConcurrentSessions: limit }))
    return manager
  }

  it("does not limit a configuration that sets no limit", async () => {
    const manager = await connectedManager()
    for (let i = 0; i < 5; i += 1) await manager.createSession("agent-1")
    expect(adapter.sessions.size).toBe(5)
  })

  it("closes the least recently active idle session to make room", async () => {
    const manager = await connectedManager(2)
    await manager.createSession("agent-1")
    await manager.createSession("agent-1")
    await manager.createSession("agent-1")
    expect(Array.from(adapter.sessions.keys())).toEqual(["s_2", "s_3"])
  })

  it("never closes a session mid-turn, and refuses when every session is busy", async () => {
    const manager = await connectedManager(1)
    const busy = await manager.createSession("agent-1")
    busy.status = "executing"
    await expect(manager.createSession("agent-1")).rejects.toMatchObject({
      code: "session_limit_reached",
    })
    expect(Array.from(adapter.sessions.keys())).toEqual([busy.id])
  })
})

describe("configured auto-approval", () => {
  it("answers a request the agent's list approves and never shows it", async () => {
    const manager = freshManager()
    manager.setLaunchPreparer(async (input) => input)
    await manager.addAgent(config({ autoApprovePatterns: ["Read"] }))
    adapter.events = [
      {
        type: "permission_request",
        sessionId: "s_1",
        timestamp: new Date(),
        request: { id: "p1", requestId: "p1", title: "Read", toolInfo: { id: "t", name: "Read" } },
      } as ExternalAgentEvent,
      {
        type: "permission_request",
        sessionId: "s_1",
        timestamp: new Date(),
        request: { id: "p2", requestId: "p2", title: "Bash", toolInfo: { id: "t", name: "Bash" } },
      } as ExternalAgentEvent,
    ]

    const seen: ExternalAgentEvent[] = []
    for await (const event of manager.executeStreaming("agent-1", "go")) seen.push(event)

    expect(adapter.responses).toEqual([
      expect.objectContaining({
        response: expect.objectContaining({ requestId: "p1", granted: true }),
      }),
    ])
    const prompted = seen
      .filter((event) => event.type === "permission_request")
      .map(
        (event) => (event as Extract<ExternalAgentEvent, { type: "permission_request" }>).request.id
      )
    expect(prompted).toEqual(["p2"])
  })
})
