import { buildLumeSandboxAdapter, lumeReference } from "./lume-adapter"
import { defaultSandboxCapabilities } from "./connection-capabilities"
import type { SandboxConnectionRow } from "@/types/sandbox"
import type { LumeClient } from "@/lib/automation/lume-client"
jest.mock("@/lib/tauri/transport-instance", () => ({ localTransport: { call: jest.fn() } }))

const row: SandboxConnectionRow = {
  id: "c",
  name: "Lume",
  provider: "lume",
  driver: "cua-driver",
  config: {
    provider: "lume",
    vmName: "owned",
    contractVersion: 1,
    resourceId: "r",
    generation: 2,
    bootEpoch: "b",
  },
  state: "running",
  capabilities: defaultSandboxCapabilities("lume", "cua-driver"),
  lastHealthStatus: "unknown",
  createdAt: 0,
  updatedAt: 0,
}
const ctx = {
  connectionId: row.id,
  provider: row.provider,
  driver: row.driver,
  capabilities: row.capabilities,
  state: row.state,
}

test("legacy and incomplete projections cannot manufacture Host references", () => {
  expect(() => lumeReference({ ...row, config: { provider: "lume", vmName: "legacy" } })).toThrow(
    "lume_resource_reference_required"
  )
})

test("lifecycle uses the exact Host reference and never advertises suspend", async () => {
  const resource = { ...lumeReference(row), state: "stopped" }
  const api = { run: jest.fn().mockResolvedValue({ resource }) } as unknown as LumeClient
  const outcome = {}
  const adapter = buildLumeSandboxAdapter(row, outcome, { lumeClient: api })
  await adapter.stop!(ctx)
  expect(api.run).toHaveBeenCalledWith({ kind: "stop", reference: lumeReference(row) }, undefined)
  expect(outcome).toEqual({ lume: resource })
  expect(adapter.suspend).toBeUndefined()
})

test("workspace execution requires a frozen native binding", async () => {
  const api = { execute: jest.fn() } as unknown as LumeClient
  const adapter = buildLumeSandboxAdapter(row, {}, { lumeClient: api })
  expect(() => adapter.workspaceExec!(ctx, { argv: ["id"] })).toThrow(
    "lume_native_binding_required"
  )
  expect(api.execute).not.toHaveBeenCalled()
})
