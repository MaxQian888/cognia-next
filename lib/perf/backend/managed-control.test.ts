import { controlManaged } from "./managed-control"
import { controlManagedProcess } from "./commands"
import { getExternalAgentManager } from "@/lib/ai/agent/external/manager"

jest.mock("./commands", () => ({
  controlManagedProcess: jest.fn().mockResolvedValue(undefined),
}))

// Stable manager object built inside the factory so the mock has no TDZ hazard
// (jest.mock is hoisted above any outer `const`).
jest.mock("@/lib/ai/agent/external/manager", () => {
  const manager = {
    disconnect: jest.fn().mockResolvedValue(undefined),
    reconnect: jest.fn().mockResolvedValue(undefined),
  }
  return { getExternalAgentManager: jest.fn(() => manager) }
})

const mockControl = controlManagedProcess as jest.Mock
const manager = getExternalAgentManager() as unknown as {
  disconnect: jest.Mock
  reconnect: jest.Mock
}

describe("controlManaged", () => {
  beforeEach(() => jest.clearAllMocks())

  it("kills an external agent through the manager, not the native command", async () => {
    await controlManaged({ subsystem: "externalAgent", id: "agent-1" }, "kill")
    expect(manager.disconnect).toHaveBeenCalledWith("agent-1")
    expect(manager.reconnect).not.toHaveBeenCalled()
    expect(mockControl).not.toHaveBeenCalled()
  })

  it("restarts an external agent via reconnect", async () => {
    await controlManaged({ subsystem: "externalAgent", id: "agent-2" }, "restart")
    expect(manager.reconnect).toHaveBeenCalledWith("agent-2")
    expect(manager.disconnect).not.toHaveBeenCalled()
    expect(mockControl).not.toHaveBeenCalled()
  })

  it("routes a chat-sidecar kill through the native command", async () => {
    await controlManaged({ subsystem: "chatSidecar", id: "chat-sidecar" }, "kill")
    expect(mockControl).toHaveBeenCalledWith("chatSidecar", "chat-sidecar", "kill")
    expect(manager.disconnect).not.toHaveBeenCalled()
  })

  it("routes an MCP-server action through the native command", async () => {
    await controlManaged({ subsystem: "mcpServer", id: "mcp-server" }, "restart")
    expect(mockControl).toHaveBeenCalledWith("mcpServer", "mcp-server", "restart")
  })

  it("routes ACP + integrated terminals through the native command", async () => {
    await controlManaged({ subsystem: "acpTerminal", id: "term_1" }, "kill")
    await controlManaged({ subsystem: "integratedTerminal", id: "pty-1" }, "kill")
    expect(mockControl).toHaveBeenNthCalledWith(1, "acpTerminal", "term_1", "kill")
    expect(mockControl).toHaveBeenNthCalledWith(2, "integratedTerminal", "pty-1", "kill")
  })
})
