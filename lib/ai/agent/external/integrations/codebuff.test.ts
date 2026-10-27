/** @jest-environment node */
import { CodebuffAdapter } from "@cognia/agent-codebuff/client"
import { createCodebuffAdapter, createCodebuffAdapterFactory } from "./codebuff"
import { runsExternalAgentProcessesLocally } from "../agent-transport"
import { resolveBundledAgentBridge } from "../host/native-bridge"
import { spawnPlacementFor } from "@/lib/sandbox/spawn-placement-registry"
jest.mock("../agent-transport", () => ({ runsExternalAgentProcessesLocally: jest.fn(() => true) }))
jest.mock("../host/process-host", () => ({
  createAgentTransportProcessHost: () => ({ available: true }),
}))
jest.mock("../host/file-host", () => ({
  createAgentTransportFileHost: () => ({ available: true }),
}))
jest.mock("../host/native-bridge", () => ({ resolveBundledAgentBridge: jest.fn() }))
jest.mock("../config/env-builder", () => ({ buildAgentEnv: jest.fn(async (_, env) => env) }))
jest.mock("../policy/tool-preapproval", () => ({ configuredApprovalPolicy: () => null }))
jest.mock("@/lib/sandbox/spawn-placement-registry", () => ({ spawnPlacementFor: jest.fn() }))
jest.mock("@/lib/network/platform-streaming-fetch", () => ({ platformStreamingFetch: jest.fn() }))
const config = {
  id: "cb",
  protocol: "codebuff-sdk",
  transport: "stdio",
  process: { command: "node", args: [], cwd: "/workspace" },
} as never
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(runsExternalAgentProcessesLocally).mockReturnValue(true)
  jest.mocked(spawnPlacementFor).mockReturnValue(undefined)
})
it("creates separate SDK clients with process-scoped cancellation", () => {
  const factory = createCodebuffAdapterFactory()
  expect(factory()).toBeInstanceOf(CodebuffAdapter)
  expect(factory()).not.toBe(factory())
  expect(createCodebuffAdapter().semantics.cancel).toEqual({
    scope: "process",
    reconnectsAfterCancel: true,
  })
})
it("refuses paired and selected-container placement before requesting the verified bridge", async () => {
  const adapter = createCodebuffAdapter()
  await adapter.connect(config)
  jest.mocked(runsExternalAgentProcessesLocally).mockReturnValue(false)
  await expect(adapter.createSession()).rejects.toThrow(/mandatory OS network isolation/)
  expect(resolveBundledAgentBridge).not.toHaveBeenCalled()
  jest.mocked(runsExternalAgentProcessesLocally).mockReturnValue(true)
  jest.mocked(spawnPlacementFor).mockReturnValue({} as never)
  await expect(adapter.createSession()).rejects.toThrow(/mandatory OS network isolation/)
})
it("never substitutes a browser executable when the verified native asset is unavailable", async () => {
  const adapter = createCodebuffAdapter()
  await adapter.connect(config)
  jest.mocked(resolveBundledAgentBridge).mockRejectedValue(new Error("native asset missing"))
  await expect(adapter.createSession()).rejects.toThrow("native asset missing")
})
