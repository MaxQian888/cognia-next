/** @jest-environment node */
import type { AgentFetch, AgentProcessHost } from "@cognia/agent-contracts/host"
import { RovoDevAdapter } from "@cognia/agent-rovo/client"
import {
  createRovoDevAdapterFactory,
  createRovoDevServiceLauncher,
  RovoOwnershipError,
} from "./rovo"
jest.mock("../agent-transport", () => ({ runsExternalAgentProcessesLocally: () => true }))
jest.mock("../host/process-host", () => ({
  createAgentTransportProcessHost: () => ({ available: true }),
}))
jest.mock("../config/env-builder", () => ({ buildAgentEnv: jest.fn(async (_, env) => env) }))
jest.mock("../policy/tool-preapproval", () => ({
  configuredApprovalPolicy: () => null,
  isToolPreApproved: () => false,
}))
jest.mock("@/lib/sandbox/spawn-placement-registry", () => ({ spawnPlacementFor: () => undefined }))
jest.mock("@/lib/network/platform-streaming-fetch", () => ({ platformStreamingFetch: jest.fn() }))
function setup(ignoreToken = false) {
  let token = ""
  const off = jest.fn(),
    host = {
      available: true,
      kill: jest.fn(async () => {}),
      onExit: async () => off,
      spawn: jest.fn(async (spec) => {
        token = spec.env.ROVODEV_SERVE_SESSION_TOKEN
        return spec.id
      }),
    } as unknown as AgentProcessHost
  const fetch = jest.fn<ReturnType<AgentFetch>, Parameters<AgentFetch>>(async (url, init) => {
    if (String(url).endsWith("/healthcheck")) return Response.json({ status: "healthy" })
    const bearer = new Headers(init?.headers).get("Authorization")
    return ignoreToken || bearer === `Bearer ${token}`
      ? Response.json({ sessions: [] })
      : new Response("", { status: 401 })
  })
  return { host, fetch, off }
}
const config = {
  id: "rovo",
  process: { command: "/usr/local/bin/acli", args: ["rovodev", "serve"], cwd: "/workspace" },
} as never
it("creates independent Rovo adapters", () => {
  const factory = createRovoDevAdapterFactory()
  expect(factory()).toBeInstanceOf(RovoDevAdapter)
  expect(factory()).not.toBe(factory())
})
it("proves endpoint ownership by rejecting missing/wrong tokens before accepting its owned token", async () => {
  const s = setup(),
    launch = createRovoDevServiceLauncher(s.host, s.fetch),
    service = await launch(config, "/workspace")
  expect(s.fetch).toHaveBeenCalledTimes(4)
  const spec = jest.mocked(s.host.spawn).mock.calls[0][0]
  expect(spec.args).toEqual([
    "rovodev",
    "serve",
    expect.stringMatching(/^4\d{4}$/),
    "--respect-configured-permissions",
  ])
  expect(service.headers?.Authorization).toBe(`Bearer ${spec.env?.ROVODEV_SERVE_SESSION_TOKEN}`)
  await service.close()
  expect(s.host.kill).toHaveBeenCalledTimes(1)
  expect(s.off).toHaveBeenCalledTimes(1)
})
it("never attaches to a token-ignoring listener and reaps the owned child", async () => {
  const s = setup(true)
  await expect(
    createRovoDevServiceLauncher(s.host, s.fetch)(config, "/workspace")
  ).rejects.toBeInstanceOf(RovoOwnershipError)
  expect(s.host.kill).toHaveBeenCalledTimes(1)
  expect(s.off).toHaveBeenCalledTimes(1)
})
it("refuses arbitrary endpoint or native launch flags", async () => {
  const s = setup(),
    launch = createRovoDevServiceLauncher(s.host, s.fetch)
  await expect(
    launch(
      { ...(config as object), network: { endpoint: "http://127.0.0.1:1234" } } as never,
      "/workspace"
    )
  ).rejects.toThrow(/external endpoints/)
  await expect(
    launch(
      {
        ...(config as object),
        process: { command: "acli", args: ["rovodev", "serve", "--other"] },
      } as never,
      "/workspace"
    )
  ).rejects.toThrow(/fixed/)
  expect(s.host.spawn).not.toHaveBeenCalled()
})
