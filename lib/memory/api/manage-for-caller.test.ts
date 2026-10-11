/** @jest-environment jsdom */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createMemory, type MemoryCreateInput } from "@/lib/db/memories"
import { findMemoryOperation } from "@/lib/db/memory-operations"
import { manageMemoryForCaller } from "./manage-for-caller"
import { companionCaller } from "./caller"

const mockManage = jest.fn()
jest.mock("@/lib/memory/control-plane/manage", () => ({
  manageMemory: (...args: unknown[]) => mockManage(...args),
}))

const mockGetSettings = jest.fn()
jest.mock("@/lib/db/settings", () => ({ getSettings: () => mockGetSettings() }))

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
afterAll(dbFixture.dispose)

const device = companionCaller("phone-1")

function row(overrides: Partial<MemoryCreateInput>): MemoryCreateInput {
  return {
    scope: "global",
    type: "semantic",
    text: "fact",
    tags: [],
    importance: 5,
    pinned: false,
    provenance: "user",
    ...overrides,
  }
}

/** Grant the phone only workspace p1. */
function restrictToWorkspace(projectId: string) {
  mockGetSettings.mockResolvedValue({
    memory: {
      principalGrants: { [device.principalId]: { scopes: ["workspace"], projects: [projectId] } },
    },
  })
}

beforeEach(async () => {
  await dbFixture.restore()
  jest.clearAllMocks()
  mockGetSettings.mockResolvedValue({ memory: {} })
  mockManage.mockImplementation(async (command: { id?: string }) => ({
    ok: true,
    memoryId: command.id ?? "mem_new",
  }))
})

describe("manageMemoryForCaller", () => {
  it("runs an unrestricted device's command through manageMemory unchanged", async () => {
    await createMemory(row({ id: "m1" }))
    await expect(
      manageMemoryForCaller({ kind: "pin", id: "m1", pinned: true }, { caller: device })
    ).resolves.toEqual({ ok: true, memoryId: "m1" })
    expect(mockManage).toHaveBeenCalledWith({ kind: "pin", id: "m1", pinned: true })
  })

  it("refuses a row outside the device's namespaces without touching the store", async () => {
    restrictToWorkspace("p1")
    await createMemory(row({ id: "g1", scope: "global" }))
    await expect(
      manageMemoryForCaller({ kind: "delete", id: "g1" }, { caller: device })
    ).resolves.toEqual({ ok: false, reason: "unauthorized_namespace" })
    expect(mockManage).not.toHaveBeenCalled()
  })

  it("checks both sides of a conflict and records the device as the resolver", async () => {
    restrictToWorkspace("p1")
    await createMemory(row({ id: "a", scope: "workspace", projectId: "p1" }))
    await createMemory(row({ id: "b", scope: "workspace", projectId: "p2" }))
    await expect(
      manageMemoryForCaller(
        { kind: "resolve-conflict", keepId: "a", dropId: "b", mode: "keep" },
        { caller: device }
      )
    ).resolves.toEqual({ ok: false, reason: "unauthorized_namespace" })

    await createMemory(row({ id: "c", scope: "workspace", projectId: "p1" }))
    await manageMemoryForCaller(
      { kind: "resolve-conflict", keepId: "a", dropId: "c", mode: "keep-both" },
      { caller: device }
    )
    expect(mockManage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "resolve-conflict", actorId: device.principalId })
    )
  })

  it("refuses to create or move a row into a namespace the device cannot reach", async () => {
    restrictToWorkspace("p1")
    await createMemory(row({ id: "w1", scope: "workspace", projectId: "p1" }))
    await expect(
      manageMemoryForCaller(
        { kind: "create", text: "x", type: "semantic", importance: 5, tags: [], scope: "global" },
        { caller: device }
      )
    ).resolves.toEqual({ ok: false, reason: "unauthorized_namespace" })
    await expect(
      manageMemoryForCaller(
        { kind: "relocate", id: "w1", target: { scope: "global" } },
        { caller: device }
      )
    ).resolves.toEqual({ ok: false, reason: "unauthorized_namespace" })
    expect(mockManage).not.toHaveBeenCalled()
  })

  it("leaves an unknown id to manageMemory, which answers not_found", async () => {
    restrictToWorkspace("p1")
    mockManage.mockResolvedValueOnce({ ok: false, reason: "not_found" })
    await expect(
      manageMemoryForCaller({ kind: "pin", id: "ghost", pinned: true }, { caller: device })
    ).resolves.toEqual({ ok: false, reason: "not_found" })
  })

  it("narrows a restricted clear to the rows the device may see", async () => {
    restrictToWorkspace("p1")
    await createMemory(row({ id: "w1", scope: "workspace", projectId: "p1" }))
    await createMemory(row({ id: "w2", scope: "workspace", projectId: "p2" }))
    await createMemory(row({ id: "g1", scope: "global" }))
    await expect(manageMemoryForCaller({ kind: "clear" }, { caller: device })).resolves.toEqual({
      ok: true,
      clearedCount: 1,
    })
    expect(mockManage).toHaveBeenCalledTimes(1)
    expect(mockManage).toHaveBeenCalledWith({ kind: "delete", id: "w1" })
  })

  it("passes an unrestricted clear straight through", async () => {
    mockManage.mockResolvedValueOnce({ ok: true, clearedCount: 4 })
    await expect(
      manageMemoryForCaller({ kind: "clear", query: { status: "invalidated" } }, { caller: device })
    ).resolves.toEqual({ ok: true, clearedCount: 4 })
    expect(mockManage).toHaveBeenCalledWith({ kind: "clear", query: { status: "invalidated" } })
  })

  describe("idempotency", () => {
    const create = {
      kind: "create" as const,
      text: "likes tea",
      type: "semantic" as const,
      importance: 5,
      tags: [],
    }

    it("replays an applied command instead of running it twice", async () => {
      mockManage.mockResolvedValueOnce({ ok: true, memoryId: "mem_tea" })
      const first = await manageMemoryForCaller(create, { caller: device, operationId: "op-1" })
      const second = await manageMemoryForCaller(create, { caller: device, operationId: "op-1" })
      expect(first).toEqual({ ok: true, memoryId: "mem_tea" })
      expect(second).toEqual({ ok: true, memoryId: "mem_tea" })
      expect(mockManage).toHaveBeenCalledTimes(1)
      const receipt = await findMemoryOperation(device.principalId, "op-1")
      expect(receipt).toMatchObject({ kind: "manage", resultCode: "ok", memoryId: "mem_tea" })
    })

    it("refuses the same operation id carrying a different command", async () => {
      await manageMemoryForCaller(create, { caller: device, operationId: "op-2" })
      await expect(
        manageMemoryForCaller(
          { ...create, text: "likes coffee" },
          {
            caller: device,
            operationId: "op-2",
          }
        )
      ).resolves.toEqual({ ok: false, reason: "idempotency_key_reused" })
    })

    it("frees the key after a refusal so a corrected retry runs", async () => {
      mockManage.mockResolvedValueOnce({ ok: false, reason: "pii_blocked" })
      await expect(
        manageMemoryForCaller(create, { caller: device, operationId: "op-3" })
      ).resolves.toEqual({ ok: false, reason: "pii_blocked" })
      expect(await findMemoryOperation(device.principalId, "op-3")).toBeUndefined()
      await expect(
        manageMemoryForCaller(create, { caller: device, operationId: "op-3" })
      ).resolves.toMatchObject({ ok: true })
      expect(mockManage).toHaveBeenCalledTimes(2)
    })

    it("frees the key when the command throws, and rethrows", async () => {
      mockManage.mockRejectedValueOnce(new Error("boom"))
      await expect(
        manageMemoryForCaller(create, { caller: device, operationId: "op-4" })
      ).rejects.toThrow("boom")
      expect(await findMemoryOperation(device.principalId, "op-4")).toBeUndefined()
    })

    it("namespaces operation ids per device", async () => {
      await manageMemoryForCaller(create, { caller: device, operationId: "op-5" })
      await manageMemoryForCaller(create, {
        caller: companionCaller("tablet-2"),
        operationId: "op-5",
      })
      expect(mockManage).toHaveBeenCalledTimes(2)
    })
  })
})
