/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { getItemMigration, latestItemMigration } from "@/lib/db/item-migrations"
import { __resetManagementChannelsForTests } from "@/lib/remote-host/management-channel"
import type { RemoteHostTarget } from "@/lib/remote-host/target-transport"
import type { Transport } from "@/lib/tauri/transport-types"
import type { ItemOwner } from "@/types/placement/item-owner"

import type { HostFacts } from "./host-facts"
import type { LoadedItem } from "./items"
import {
  finishPendingTakeBack,
  MIGRATION_LEASE_OPERATIONS,
  MIGRATION_LEASE_TTL_SECONDS,
  moveItems,
  requestMigrationLease,
  resumeMove,
  takeBackItem,
  type MigrationServiceDeps,
} from "./service"

const mockCreate = jest.fn()
const mockStatus = jest.fn()
const mockSetOwner = jest.fn()
const mockArm = jest.fn()
const mockRemove = jest.fn()
const companionCalls: string[] = []
const mockCompanionRemove = jest.fn(async () => "paused" as string | null)
jest.mock("./items", () => ({
  ...jest.requireActual("./items"),
  createOnHost: (...args: unknown[]) => mockCreate(...args),
  remoteStatus: (...args: unknown[]) => mockStatus(...args),
  setLocalOwner: (...args: unknown[]) => mockSetOwner(...args),
  armOnHost: (...args: unknown[]) => mockArm(...args),
  removeFromHost: (...args: unknown[]) => mockRemove(...args),
  createCompanionOnHost: async (companion: { id: string }) => {
    companionCalls.push(`create:${companion.id}`)
  },
  setCompanionOwner: async (companion: { id: string }, owner: unknown, status?: string) => {
    companionCalls.push(`owner:${companion.id}:${owner ? "remote" : "here"}:${status ?? ""}`)
  },
  armCompanionOnHost: async (companion: { id: string }) => {
    companionCalls.push(`arm:${companion.id}`)
  },
  removeCompanionFromHost: async (companion: { id: string }) => {
    companionCalls.push(`remove:${companion.id}`)
    return mockCompanionRemove()
  },
}))
const mockCheck = jest.fn()
jest.mock("./preflight", () => ({
  ...jest.requireActual("./preflight"),
  preflightItems: (...args: unknown[]) => mockCheck(...args),
}))

const HOST = "mini"
const OP = "123e4567-e89b-42d3-a456-426614174000"
const moved: ItemOwner = {
  kind: "remote-host",
  hostId: HOST,
  hostLabel: "Mac mini",
  remoteItemId: "task-1",
  operationId: OP,
  movedAt: 1,
}

let owner: ItemOwner | undefined
const call = jest.fn()

function deps(overrides: Partial<MigrationServiceDeps> = {}): MigrationServiceDeps {
  const transport: Transport = { call: call as never, subscribe: jest.fn(() => () => undefined) }
  return {
    channel: {
      openTarget: async () =>
        ({
          host: { id: HOST, label: "Mac mini", config: { deviceId: "d" } },
          transport,
          close: jest.fn(),
        }) as unknown as RemoteHostTarget,
    },
    facts: () => ({}) as HostFacts,
    load: async (ref) =>
      ({
        kind: ref.kind,
        id: ref.id,
        label: "Morning digest",
        localStatus: "active",
        ...(owner ? { owner } : {}),
      }) as LoadedItem,
    now: () => 100,
    newOperationId: () => OP,
    sourceLabel: () => "Work laptop",
    ...overrides,
  }
}

function ready(id = "task-1") {
  return {
    item: { kind: "scheduled-task", id },
    label: "Morning digest",
    localStatus: "active",
    ready: true,
    blockers: [],
    notes: [],
    plugins: [],
    checkedAt: 1,
  }
}

beforeEach(async () => {
  __resetDbForTesting()
  __resetManagementChannelsForTests()
  await getDb().itemMigrations.clear()
  owner = undefined
  for (const mock of [mockCreate, mockStatus, mockSetOwner, mockArm, mockRemove, mockCheck, call]) {
    mock.mockReset()
  }
  companionCalls.length = 0
  mockCompanionRemove.mockReset().mockResolvedValue("paused")
  mockStatus.mockResolvedValue("paused")
  mockCheck.mockImplementation(async (refs: Array<{ kind: string; id: string }>) =>
    refs.map((ref) => ({ ...ready(ref.id), item: ref }))
  )
}, 15_000)

describe("moveItems", () => {
  it("creates, confirms, fences, then arms, recording each step", async () => {
    const order: string[] = []
    mockCreate.mockImplementation(async () => order.push("create"))
    mockStatus.mockImplementation(async () => (order.push("confirm"), "paused"))
    mockSetOwner.mockImplementation(async () => order.push("fence"))
    mockArm.mockImplementation(async () => order.push("arm"))

    const outcomes = await moveItems(
      HOST,
      [{ kind: "scheduled-task", id: "task-1" }],
      { adminLease: "lease" },
      deps()
    )
    expect(outcomes).toEqual([
      {
        item: { kind: "scheduled-task", id: "task-1" },
        operationId: OP,
        ok: true,
        state: "completed",
      },
    ])
    expect(order).toEqual(["create", "confirm", "fence", "arm"])
    expect(mockCreate.mock.calls[0]?.[1]).toMatchObject({
      adminLease: "lease",
      operationId: OP,
      sourceLabel: "Work laptop",
    })
    expect(mockSetOwner).toHaveBeenCalledWith("scheduled-task", "task-1", {
      kind: "remote-host",
      hostId: HOST,
      hostLabel: "Mac mini",
      remoteItemId: "task-1",
      operationId: OP,
      movedAt: 100,
    })
    const journal = await getItemMigration(OP)
    expect(journal?.history.map((step) => step.state)).toEqual([
      "prepared",
      "created",
      "fenced",
      "completed",
    ])
    expect(journal).toMatchObject({ localStatus: "active", remoteItemId: "task-1" })
  })

  it("never fences an item the host did not keep", async () => {
    mockStatus.mockResolvedValue(null)
    const [outcome] = await moveItems(
      HOST,
      [{ kind: "scheduled-task", id: "task-1" }],
      { adminLease: "lease" },
      deps()
    )
    expect(outcome).toMatchObject({ ok: false, state: "failed" })
    expect(outcome?.error).toMatch(/item_not_on_host/)
    expect(mockSetOwner).not.toHaveBeenCalled()
    expect(await getItemMigration(OP)).toMatchObject({ state: "failed", resumeFrom: "created" })
  })

  it("leaves an item that is no longer ready untouched", async () => {
    mockCheck.mockResolvedValue([
      { ...ready(), ready: false, blockers: [{ kind: "host-too-old" }] },
    ])
    const [outcome] = await moveItems(
      HOST,
      [{ kind: "scheduled-task", id: "task-1" }],
      { adminLease: "lease" },
      deps()
    )
    expect(outcome).toMatchObject({ ok: false, state: "blocked", error: "host-too-old" })
    expect(mockCreate).not.toHaveBeenCalled()
    expect(await getItemMigration(OP)).toBeUndefined()
  })

  it("resumes a failed move from its step, under the same operation id", async () => {
    mockArm.mockRejectedValueOnce(new Error("relay dropped"))
    const [first] = await moveItems(
      HOST,
      [{ kind: "scheduled-task", id: "task-1" }],
      { adminLease: "lease" },
      deps()
    )
    expect(first).toMatchObject({ ok: false, error: "relay dropped" })
    expect(await getItemMigration(OP)).toMatchObject({ state: "failed", resumeFrom: "fenced" })

    mockCreate.mockClear()
    mockSetOwner.mockClear()
    const resumed = await resumeMove(OP, { adminLease: "lease-2" }, deps())
    expect(resumed).toMatchObject({ ok: true, state: "completed", operationId: OP })
    // Only the step that had not happened runs again.
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockSetOwner).not.toHaveBeenCalled()
    expect(mockArm).toHaveBeenCalledTimes(2)
  })

  it("picks an interrupted move back up when the same item is moved again", async () => {
    mockCreate.mockRejectedValueOnce(new Error("host restarting"))
    await moveItems(HOST, [{ kind: "scheduled-task", id: "task-1" }], { adminLease: "l" }, deps())
    await moveItems(
      HOST,
      [{ kind: "scheduled-task", id: "task-1" }],
      { adminLease: "l" },
      deps({ newOperationId: () => "should-not-be-used" })
    )
    expect(mockCreate.mock.calls.map(([, context]) => context.operationId)).toEqual([OP, OP])
    expect((await latestItemMigration("scheduled-task", "task-1"))?.state).toBe("completed")
  })
})

describe("takeBackItem", () => {
  it("removes the host's copy, then restores this one with the host's status", async () => {
    owner = moved
    mockStatus.mockResolvedValue("paused")
    const outcome = await takeBackItem(
      { kind: "scheduled-task", id: "task-1" },
      { adminLease: "lease" },
      deps({ newOperationId: () => "take-1" })
    )
    expect(outcome).toMatchObject({ ok: true, state: "completed", operationId: "take-1" })
    expect(mockRemove).toHaveBeenCalledWith(
      "scheduled-task",
      "task-1",
      expect.objectContaining({ adminLease: "lease" })
    )
    expect(mockSetOwner).toHaveBeenCalledWith("scheduled-task", "task-1", undefined, "paused")
  })

  it("restores without removing when the host already dropped it", async () => {
    owner = moved
    mockStatus.mockResolvedValue(null)
    await takeBackItem(
      { kind: "scheduled-task", id: "task-1" },
      { adminLease: "lease" },
      deps({ newOperationId: () => "take-1" })
    )
    expect(mockRemove).not.toHaveBeenCalled()
    expect(mockSetOwner).toHaveBeenCalledWith("scheduled-task", "task-1", undefined, "paused")
  })

  it("only restores an unreachable host's item when asked to, and remembers to finish", async () => {
    owner = moved
    mockStatus.mockRejectedValue(new Error("no route"))
    const refused = await takeBackItem(
      { kind: "scheduled-task", id: "task-1" },
      { adminLease: "lease" },
      deps({ newOperationId: () => "take-1" })
    )
    expect(refused).toMatchObject({ ok: false, state: "failed", error: "no route" })
    expect(mockSetOwner).not.toHaveBeenCalled()

    const forced = await takeBackItem(
      { kind: "scheduled-task", id: "task-1" },
      { evenIfHostUnreachable: true },
      deps({ newOperationId: () => "take-2" })
    )
    expect(forced).toMatchObject({ ok: true, state: "awaiting-host" })
    expect(mockSetOwner).toHaveBeenCalledWith("scheduled-task", "task-1", undefined, "paused")

    mockStatus.mockReset().mockResolvedValue("active")
    const finished = await finishPendingTakeBack("take-2", { adminLease: "lease" }, deps())
    expect(finished).toMatchObject({ ok: true, state: "completed" })
    expect(mockRemove).toHaveBeenCalledTimes(1)
  })

  it("restores the status the item had before it moved, when the host cannot say", async () => {
    owner = undefined
    mockStatus.mockResolvedValue("paused")
    await moveItems(HOST, [{ kind: "scheduled-task", id: "task-1" }], { adminLease: "l" }, deps())
    owner = moved
    mockStatus.mockRejectedValue(new Error("offline"))
    await takeBackItem(
      { kind: "scheduled-task", id: "task-1" },
      { evenIfHostUnreachable: true },
      deps({ newOperationId: () => "take-1" })
    )
    expect(mockSetOwner).toHaveBeenLastCalledWith("scheduled-task", "task-1", undefined, "active")
  })

  it("refuses an item that already runs here", async () => {
    await expect(
      takeBackItem({ kind: "scheduled-task", id: "task-1" }, { adminLease: "l" }, deps())
    ).rejects.toThrow(/item_not_moved/)
  })
})

describe("a connector's chat schedules", () => {
  const schedule = (id: string, status: string) =>
    ({
      id,
      name: id,
      type: "connection:scheduled:digest",
      status,
      payload: { adapterId: "c1" },
    }) as never

  function connectorDeps(newOperationId: string) {
    return deps({
      newOperationId: () => newOperationId,
      load: async (ref) =>
        ({
          kind: ref.kind,
          id: ref.id,
          label: "Team Telegram",
          localStatus: "enabled",
          ...(owner ? { owner } : {}),
          row: { id: ref.id },
          schedules: [schedule("d1", "active"), schedule("d2", "paused")],
        }) as unknown as LoadedItem,
    })
  }

  it("move with the connector: created after it, fenced with it, armed after it", async () => {
    mockStatus.mockResolvedValue("disabled")
    await moveItems(
      HOST,
      [{ kind: "connector-instance", id: "c1" }],
      { adminLease: "l" },
      connectorDeps(OP)
    )
    expect(companionCalls).toEqual([
      "create:d1",
      "create:d2",
      "owner:d1:remote:",
      "owner:d2:remote:",
      "arm:d1",
      "arm:d2",
    ])
    expect((await getItemMigration(OP))?.companions).toEqual([
      { kind: "scheduled-task", id: "d1", label: "d1", localStatus: "active" },
      { kind: "scheduled-task", id: "d2", label: "d2", localStatus: "paused" },
    ])
  })

  it("come back with the connector, removed from the host first, with the host's status", async () => {
    mockStatus.mockResolvedValue("disabled")
    await moveItems(
      HOST,
      [{ kind: "connector-instance", id: "c1" }],
      { adminLease: "l" },
      connectorDeps(OP)
    )
    companionCalls.length = 0
    owner = { ...moved, remoteItemId: "c1" }
    mockStatus.mockResolvedValue("enabled")
    mockCompanionRemove.mockResolvedValueOnce("active").mockResolvedValueOnce(null)
    const order: string[] = []
    mockRemove.mockImplementation(async () =>
      order.push(`remove-connector after ${companionCalls.length}`)
    )
    await takeBackItem(
      { kind: "connector-instance", id: "c1" },
      { adminLease: "l" },
      connectorDeps("take-1")
    )
    expect(order).toEqual(["remove-connector after 2"])
    // d1: the host's status; d2: the host had none, so its own from before the move.
    expect(companionCalls.slice(2)).toEqual(["owner:d1:here:active", "owner:d2:here:paused"])
  })
})

describe("requestMigrationLease", () => {
  it("asks the host for one lease covering every interactive write of a batch", async () => {
    call.mockResolvedValue({ token: "t", operations: [], expiresAt: 1 })
    await expect(requestMigrationLease(HOST, deps())).resolves.toMatchObject({ token: "t" })
    expect(call).toHaveBeenCalledWith("host_admin_lease_issue", {
      operations: [...MIGRATION_LEASE_OPERATIONS],
      ttlSeconds: MIGRATION_LEASE_TTL_SECONDS,
    })
  })
})
