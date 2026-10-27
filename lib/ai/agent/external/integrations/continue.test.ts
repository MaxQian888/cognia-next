/** @jest-environment node */
import { ContinueAdapter } from "@cognia/agent-continue/client"
import { createContinueAdapter, createContinueAdapterFactory } from "./continue"
jest.mock("../host/process-host", () => ({
  createAgentTransportProcessHost: jest.fn(() => ({ available: false })),
}))
jest.mock("../host/file-host", () => ({
  createAgentTransportFileHost: jest.fn(() => ({ available: false })),
}))
jest.mock("../config/env-builder", () => ({ buildAgentEnv: jest.fn(async (_, env) => env) }))
it("registers independent Continue clients with explicit history replay and fixed permissions", () => {
  const factory = createContinueAdapterFactory(),
    one = factory()
  expect(one).toBeInstanceOf(ContinueAdapter)
  expect(one).not.toBe(factory())
  expect(createContinueAdapter().semantics).toMatchObject({
    resume: "history-replay",
    approvals: "profile-fixed",
    processModel: "per-turn",
  })
})
it("fails before connecting when the current host has no process plane", async () => {
  await expect(
    createContinueAdapter().connect({ transport: "stdio", process: { command: "cn" } } as never)
  ).rejects.toThrow(/host ports/)
})
