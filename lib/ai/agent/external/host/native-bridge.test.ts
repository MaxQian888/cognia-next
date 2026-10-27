import { agentInvoke } from "../agent-transport"
import { resolveBundledAgentBridge, type BundledAgentBridgeId } from "./native-bridge"
jest.mock("../agent-transport", () => ({ agentInvoke: jest.fn() }))
const invoke = jest.mocked(agentInvoke)
beforeEach(() => jest.clearAllMocks())
it.each([
  ["codebuff", "--cognia-codebuff-bridge"],
  ["crush-http", "--cognia-crush-bridge"],
  ["hermes-probe", "--hermes-gateway-probe"],
  ["hermes-acp", "--cognia-hermes-acp"],
] as const)("resolves verified %s through the existing host transport", async (id, flag) => {
  const launch = {
    command: "/owned/node",
    args: [`/owned/sidecar/native-agents/${id}.cjs`, flag],
    sha256: "a".repeat(64),
  }
  invoke.mockResolvedValueOnce(launch)
  await expect(resolveBundledAgentBridge(id)).resolves.toEqual(launch)
  expect(invoke).toHaveBeenCalledWith("resolve_bundled_agent_bridge", { id })
})
it.each([
  null,
  {
    command: "node",
    args: ["/owned/native-agents/codebuff.cjs", "--cognia-codebuff-bridge"],
    sha256: "a".repeat(64),
  },
  {
    command: "/owned/node",
    args: ["/tmp/other.cjs", "--cognia-codebuff-bridge"],
    sha256: "a".repeat(64),
  },
  {
    command: "/owned/node",
    args: ["/owned/native-agents/codebuff.cjs", "--eval"],
    sha256: "a".repeat(64),
  },
  {
    command: "/owned/node",
    args: ["/owned/native-agents/codebuff.cjs", "--cognia-codebuff-bridge", "extra"],
    sha256: "a".repeat(64),
  },
  {
    command: "/owned/node",
    args: ["/owned/native-agents/codebuff.cjs", "--cognia-codebuff-bridge"],
    sha256: "invalid",
  },
])("rejects malformed or unverified host output %p", async (output) => {
  invoke.mockResolvedValueOnce(output)
  await expect(resolveBundledAgentBridge("codebuff")).rejects.toThrow(/verified codebuff bridge/)
})
it("surfaces an unavailable host and refuses unknown bridge ids before invoking", async () => {
  invoke.mockRejectedValueOnce(new Error("native host unavailable"))
  await expect(resolveBundledAgentBridge("codebuff")).rejects.toThrow("native host unavailable")
  await expect(resolveBundledAgentBridge("unknown" as BundledAgentBridgeId)).rejects.toThrow(
    /Unsupported/
  )
  expect(invoke).toHaveBeenCalledTimes(1)
})
