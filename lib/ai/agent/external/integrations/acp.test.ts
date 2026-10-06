import { AcpClientAdapter } from "@cognia/agent-acp/client"
import { DevinAcpAdapter } from "@cognia/agent-acp/devin-adapter"
import {
  ACP_EXECUTION_SEMANTICS,
  ACP_REMOTE_EXECUTION_SEMANTICS,
  DEVIN_ACP_EXECUTION_SEMANTICS,
} from "@cognia/agent-acp/manifest"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { platformStreamingFetch } from "@/lib/network/platform-streaming-fetch"
import { createPlatformWebSocket } from "@/lib/network/platform-websocket"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { getAcpHostCapabilities } from "../agent-transport"
import { buildAgentEnv } from "../config/env-builder"
import { configuredApprovalPolicy, isToolPreApproved } from "../policy/tool-preapproval"
import {
  createAcpAdapterFactory,
  createAcpClientAdapter,
  createAcpClientDeps,
  createDevinAcpAdapter,
  setAcpDynamicMcpHostController,
} from "./acp"

afterEach(() => setAcpDynamicMcpHostController(undefined))

describe("ACP host wiring", () => {
  it("hands the client the app's own policies, network clients and gate", () => {
    const deps = createAcpClientDeps()
    expect(deps.requestFetch).toBe(proxyFetch)
    expect(deps.streamFetch).toBe(platformStreamingFetch)
    expect(deps.openWebSocket).toBe(createPlatformWebSocket)
    expect(deps.hostCapabilities).toBe(getAcpHostCapabilities)
    expect(deps.resolveLaunchEnvironment).toBe(buildAgentEnv)
    expect(deps.approvalPolicy).toBe(configuredApprovalPolicy)
    expect(deps.toolPreApproval).toBe(isToolPreApproved)
    expect(deps.outboundGate).toBe(hasNoLeakingPiiDeep)
  })

  it("reads the dynamic-MCP controller live", () => {
    const deps = createAcpClientDeps()
    expect(deps.dynamicMcpHost()).toBeUndefined()
    const controller = { connect: jest.fn(), message: jest.fn(), disconnect: jest.fn() }
    setAcpDynamicMcpHostController(controller)
    expect(deps.dynamicMcpHost()).toBe(controller)
    setAcpDynamicMcpHostController(undefined)
    expect(deps.dynamicMcpHost()).toBeUndefined()
  })

  it("bounds every logged string through the app logger", () => {
    const { loggers } = jest.requireActual("@cognia/logging") as typeof import("@cognia/logging")
    const debug = jest.spyOn(loggers.agent, "debug").mockImplementation(() => {})
    try {
      createAcpClientDeps().logger.debug("stderr", { data: "E".repeat(5000) })
      const data = (debug.mock.calls[0]?.[1] as { data: string }).data
      expect(data.length).toBeLessThan(5000)
      expect(data).toContain("chars truncated")
    } finally {
      debug.mockRestore()
    }
  })

  it("registers an independent acp adapter per configuration", () => {
    const factory = createAcpAdapterFactory()
    const a = factory()
    expect(a).toBeInstanceOf(AcpClientAdapter)
    expect(a).not.toBe(factory())
    expect(a.protocol).toBe("acp")
  })

  it("declares stdio and network semantics from the configuration's transport", async () => {
    const adapter = createAcpClientAdapter()
    expect(adapter.semantics).toBe(ACP_EXECUTION_SEMANTICS)
    await adapter
      .connect({
        id: "remote",
        name: "Remote",
        protocol: "acp",
        transport: "websocket",
        network: {},
      } as never)
      .catch(() => undefined)
    expect(adapter.semantics).toBe(ACP_REMOTE_EXECUTION_SEMANTICS)
  })

  it("wraps native Devin in the per-conversation adapter", () => {
    const devin = createDevinAcpAdapter(createAcpClientAdapter())
    expect(devin).toBeInstanceOf(DevinAcpAdapter)
    expect(devin.semantics).toBe(DEVIN_ACP_EXECUTION_SEMANTICS)
  })
})
