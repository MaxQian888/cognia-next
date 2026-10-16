jest.mock("@/lib/automation/managed-desktop-client", () => ({ managedDesktopClient: {} }))
import type { SandboxConnectionRow } from "@/types/sandbox"
import type { ManagedDesktopClient } from "@/lib/automation/managed-desktop-client"
import { defaultSandboxCapabilities } from "./connection-capabilities"
import { buildE2bSandboxAdapter } from "./e2b-adapter"
import { runSandboxOperation, type SandboxAdapterOutcome } from "./lifecycle-contract"

function row(qualified = false): SandboxConnectionRow {
  return {
    id: "row",
    name: "desktop",
    provider: "e2b",
    driver: "computer-server",
    config: {
      provider: "e2b",
      providerConfigId: "byo",
      target: { kind: "remote", hostId: "host-b" },
      desktopId: "desktop",
      generation: 2,
      qualification: qualified ? "qualified" : "unqualified",
    },
    state: "uninitialized",
    capabilities: defaultSandboxCapabilities("e2b", "computer-server"),
    lastHealthStatus: "unknown",
    createdAt: 0,
    updatedAt: 0,
  }
}
function client() {
  return {
    create: jest.fn(),
    connect: jest.fn(),
    health: jest.fn(),
    delete: jest.fn(),
  } as unknown as jest.Mocked<ManagedDesktopClient>
}

test("unqualified create refuses even with a forged stored capability", async () => {
  const source = row()
  const api = client()
  const adapter = buildE2bSandboxAdapter(source, {}, { managedClient: api })
  await expect(
    runSandboxOperation(adapter, { ...source, connectionId: source.id }, "create", (a) =>
      a.create?.({ ...source, connectionId: source.id })
    )
  ).rejects.toMatchObject({ code: "provider-unqualified" })
  expect(api.create).not.toHaveBeenCalled()
})

test("a qualified create still requires Host-recorded authorization", async () => {
  const source = row(true)
  const api = client()
  const adapter = buildE2bSandboxAdapter(source, {}, { managedClient: api })
  await expect(adapter.create!({ ...source, connectionId: source.id })).rejects.toMatchObject({
    code: "authorization-required",
  })
  expect(api.create).not.toHaveBeenCalled()
})

test("connect and cleanup remain Host-bound while unqualified", async () => {
  const source = row()
  const api = client()
  const outcome: SandboxAdapterOutcome = {}
  const resource = { id: "desktop", generation: 2, state: "running" }
  api.connect.mockResolvedValue(resource as never)
  const adapter = buildE2bSandboxAdapter(source, outcome, { managedClient: api })
  const ctx = { ...source, connectionId: source.id }
  await adapter.connect!(ctx)
  expect(api.connect).toHaveBeenCalledWith(
    source.config.provider === "e2b" ? source.config.target : null,
    { desktopId: "desktop", generation: 2 }
  )
  expect(outcome.managedDesktop).toEqual(resource)
  await adapter.delete!(ctx)
  expect(api.delete).toHaveBeenCalled()
})

test("Phase 1 never advertises GUI, workspace, pause, resume or stop", async () => {
  const source = row(true)
  const api = client()
  const adapter = buildE2bSandboxAdapter(source, {}, { managedClient: api })
  for (const operation of [
    "gui",
    "workspaceRead",
    "workspaceExec",
    "suspend",
    "resume",
    "start",
    "stop",
  ] as const) {
    await expect(
      runSandboxOperation(adapter, { ...source, connectionId: source.id }, operation, () =>
        Promise.resolve()
      )
    ).rejects.toMatchObject({ code: "unsupported-operation" })
  }
})
