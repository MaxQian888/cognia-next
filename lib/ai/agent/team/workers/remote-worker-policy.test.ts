import {
  decodeRemoteWorkerPolicy,
  encodeRemoteWorkerPolicy,
  resolveRemoteWorkerOptions,
  remoteWorkerCeiling,
} from "./remote-worker-policy"
import type { BuildOptionsContext } from "@/lib/claude/build-options"
const mockResolve = jest.fn()
jest.mock("@/lib/claude/build-options", () => ({
  resolveSendOptions: (...args: unknown[]) => mockResolve(...args),
}))

it("translates workspace roots without transporting parent paths or MCP credentials", () => {
  const encoded = encodeRemoteWorkerPolicy(
    {
      allowedTools: [],
      mcpServers: [{ name: "docs", apiKey: "private" }],
      sandboxPolicy: { writableRoots: ["/parent/repo/src"], network: "off" },
    },
    true,
    "/parent/repo"
  )!
  expect(JSON.stringify(encoded)).not.toContain("private")
  expect(JSON.stringify(encoded)).not.toContain("/parent")
  expect(decodeRemoteWorkerPolicy(encoded, "/worker/task")).toMatchObject({
    allowedTools: [],
    mcpServers: [{ name: "docs" }],
    sandboxPolicy: { writableRoots: ["/worker/task/src"], network: "off" },
  })
  expect(() =>
    encodeRemoteWorkerPolicy(
      { sandboxPolicy: { writableRoots: ["/elsewhere"] } },
      true,
      "/parent/repo"
    )
  ).toThrow("cannot enforce")
})

it("intersects both host and sender path and network ceilings without replacing narrower roots", async () => {
  const policy = {
    policyVersion: 1 as const,
    sandboxRequired: true,
    sandboxPolicy: { writableRoots: ["src"], readableRoots: ["docs"], network: "on" as const },
  }
  const effective = remoteWorkerCeiling(policy, "/worker", {
    sandboxPolicy: {
      writableRoots: ["/worker"],
      readableRoots: ["/worker/docs/public"],
      network: "off",
    },
  })
  expect(effective.sandboxPolicy).toMatchObject({
    writableRoots: ["/worker/src"],
    readableRoots: ["/worker/docs/public"],
    network: "off",
  })
  expect(() =>
    remoteWorkerCeiling(policy, "/worker", { sandboxPolicy: { writableRoots: ["/elsewhere"] } })
  ).toThrow("empty writableRoots")
  mockResolve.mockResolvedValue({})
  await resolveRemoteWorkerOptions(
    { appSettings: { sandboxPolicy: { network: "off" } } } as BuildOptionsContext,
    policy,
    "/worker"
  )
  expect(mockResolve).toHaveBeenLastCalledWith(
    expect.objectContaining({
      appSettings: expect.objectContaining({
        sandboxPolicy: expect.objectContaining({ network: "off" }),
      }),
    })
  )
})

it("lowers restrictions through the ordinary permission clamp and removes excluded MCP servers", async () => {
  mockResolve.mockResolvedValue({ mcpServers: { allowed: {}, excluded: {} } })
  const result = await resolveRemoteWorkerOptions(
    {
      session: { id: "s" },
      preloadedMcpServers: [{ name: "allowed" }, { name: "excluded" }],
    } as BuildOptionsContext,
    {
      policyVersion: 1,
      permissionMode: "plan",
      allowedTools: ["Read"],
      mcpServerNames: ["allowed"],
      sandboxRequired: true,
    },
    "/worker"
  )
  expect(mockResolve).toHaveBeenCalledWith(
    expect.objectContaining({
      permissionCeiling: {
        permissionMode: "plan",
        allowedTools: ["Read"],
        mcpServers: [{ name: "allowed" }],
      },
      preloadedMcpServers: [{ name: "allowed" }],
      session: { id: "s", sandboxEnabled: true },
    })
  )
  expect(result.mcpServers).toEqual({ allowed: {} })
})
