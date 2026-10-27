/** @jest-environment node */
import { CrushAdapter } from "@cognia/agent-crush/client"
import { createCrushAdapter, createCrushAdapterFactory } from "./crush"
import { runsExternalAgentProcessesLocally } from "../agent-transport"
import { resolveBundledAgentBridge } from "../host/native-bridge"
import { spawnPlacementFor } from "@/lib/sandbox/spawn-placement-registry"
jest.mock("../agent-transport", () => ({ runsExternalAgentProcessesLocally: jest.fn(() => true) }))
jest.mock("../host/process-host", () => ({
  createAgentTransportProcessHost: () => ({ available: true }),
}))
jest.mock("../host/native-bridge", () => ({
  resolveBundledAgentBridge: jest.fn(async () => ({
    command: "/verified/node",
    args: ["/verified/native-agents/crush-http.cjs", "--cognia-crush-bridge"],
  })),
}))
jest.mock("../config/env-builder", () => ({ buildAgentEnv: jest.fn(async (_, env) => env) }))
jest.mock("../policy/tool-preapproval", () => ({
  configuredApprovalPolicy: () => null,
  isToolPreApproved: () => false,
}))
jest.mock("@/lib/sandbox/spawn-placement-registry", () => ({ spawnPlacementFor: jest.fn() }))
const config = {
  id: "crush",
  protocol: "crush-http",
  transport: "http",
  process: { command: "crush", args: [], cwd: "/workspace" },
} as never
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(runsExternalAgentProcessesLocally).mockReturnValue(true)
  jest.mocked(spawnPlacementFor).mockReturnValue(undefined)
})
it("creates independent private-socket adapters without importing Node into the app", () => {
  const factory = createCrushAdapterFactory()
  expect(factory()).toBeInstanceOf(CrushAdapter)
  expect(factory()).not.toBe(factory())
  expect(createCrushAdapter().protocol).toBe("crush-http")
})
it("refuses a paired host or selected runtime before bridge resolution", async () => {
  const adapter = createCrushAdapter()
  await adapter.connect(config)
  jest.mocked(runsExternalAgentProcessesLocally).mockReturnValue(false)
  await expect(adapter.createSession()).rejects.toThrow(/local process host/)
  expect(resolveBundledAgentBridge).not.toHaveBeenCalled()
  jest.mocked(runsExternalAgentProcessesLocally).mockReturnValue(true)
  jest.mocked(spawnPlacementFor).mockReturnValue({} as never)
  await expect(adapter.createSession()).rejects.toThrow(/local process host/)
})
