/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { putItemMigration } from "@/lib/db/item-migrations"
import { buildLocalHostFeatureManifest } from "@/lib/platform/host-feature-manifest"

import type { HostFacts } from "./host-facts"
import type { LoadedItem } from "./items"
import { preflightItems, resolveBatchDependencies, sortForMigration } from "./preflight"
import type { MigrationPreflight } from "./types"

const mockCheckItem = jest.fn()
jest.mock("./items", () => ({
  ...jest.requireActual("./items"),
  checkItem: (...args: unknown[]) => mockCheckItem(...args),
}))

function facts(manifest: () => Promise<unknown>): HostFacts {
  return {
    manifest: manifest as HostFacts["manifest"],
    ids: async () => new Set(),
    plugins: async () => new Map(),
    botCatalog: async () => new Map(),
    botCredentialIds: async () => new Set(),
    externalAgentIds: async () => new Set(),
    hasScheduledTask: async () => false,
  }
}

const headless = facts(async () => buildLocalHostFeatureManifest({ platform: "headless" }))

function item(kind: LoadedItem["kind"], id: string, overrides: Partial<LoadedItem> = {}) {
  return { kind, id, label: id, localStatus: "active", ...overrides } as LoadedItem
}

beforeEach(async () => {
  __resetDbForTesting()
  await getDb().itemMigrations.clear()
  mockCheckItem.mockReset().mockResolvedValue({ blockers: [], notes: [], plugins: [] })
}, 15_000)

describe("preflightItems", () => {
  it("passes an item nothing blocks, checked against the host's own platform", async () => {
    const [result] = await preflightItems([{ kind: "scheduled-task", id: "t" }], headless, {
      load: async () => item("scheduled-task", "t"),
      now: () => 9,
    })
    expect(result).toEqual({
      item: { kind: "scheduled-task", id: "t" },
      label: "t",
      localStatus: "active",
      checkedAt: 9,
      ready: true,
      blockers: [],
      notes: [],
      plugins: [],
    })
    expect(mockCheckItem.mock.calls[0]?.[2]).toBe("headless")
    expect(mockCheckItem.mock.calls[0]?.[3]).toBe(false)
  })

  it("stops at a host too old to receive work, without asking it anything else", async () => {
    const tooOld = buildLocalHostFeatureManifest({ platform: "headless" })
    delete (tooOld.features as Record<string, unknown>)["always-on.migration"]
    const [result] = await preflightItems(
      [{ kind: "scheduled-task", id: "t" }],
      facts(async () => tooOld),
      { load: async () => item("scheduled-task", "t") }
    )
    expect(result?.blockers).toEqual([{ kind: "host-too-old" }])
    expect(mockCheckItem).not.toHaveBeenCalled()
  })

  it("reports a host it could not reach, verbatim", async () => {
    const [result] = await preflightItems(
      [{ kind: "scheduled-task", id: "t" }],
      facts(async () => Promise.reject(new Error("no route to host"))),
      { load: async () => item("scheduled-task", "t") }
    )
    expect(result?.blockers).toEqual([{ kind: "host-unreachable", detail: "no route to host" }])
  })

  it("refuses an item that already runs on a host", async () => {
    const [result] = await preflightItems([{ kind: "bot-installation", id: "b" }], headless, {
      load: async () =>
        item("bot-installation", "b", {
          owner: {
            kind: "remote-host",
            hostId: "h",
            hostLabel: "Mac mini",
            remoteItemId: "r",
            operationId: "o",
            movedAt: 1,
          },
        }),
    })
    expect(result?.blockers).toEqual([{ kind: "already-moved", hostLabel: "Mac mini" }])
  })

  it("tells the checks a move is resuming, so its own copy is not a conflict", async () => {
    await putItemMigration({
      operationId: "op",
      direction: "move",
      itemKind: "scheduled-task",
      itemId: "t",
      itemLabel: "t",
      hostId: "h",
      hostLabel: "Mac mini",
      localStatus: "active",
      state: "created",
      history: [],
      createdAt: 1,
      updatedAt: 1,
    })
    await preflightItems([{ kind: "scheduled-task", id: "t" }], headless, {
      load: async () => item("scheduled-task", "t"),
    })
    expect(mockCheckItem.mock.calls[0]?.[3]).toBe(true)
  })

  it("refuses an item that is not on this machine", async () => {
    await expect(
      preflightItems([{ kind: "scheduled-task", id: "gone" }], headless, {
        load: async () => undefined,
      })
    ).rejects.toThrow(/item_missing/)
  })
})

describe("batch order and dependencies", () => {
  it("moves connectors first, then Bots, then tasks", () => {
    expect(
      sortForMigration([
        { kind: "scheduled-task" as const, id: "t" },
        { kind: "bot-installation" as const, id: "b" },
        { kind: "connector-instance" as const, id: "c" },
      ]).map((ref) => ref.kind)
    ).toEqual(["connector-instance", "bot-installation", "scheduled-task"])
  })

  it("lets a Bot ride along with its connector, but not ahead of a blocked one", () => {
    const preflight = (
      kind: MigrationPreflight["item"]["kind"],
      id: string,
      blockers: MigrationPreflight["blockers"]
    ): MigrationPreflight => ({
      item: { kind, id },
      label: id,
      localStatus: "enabled",
      ready: blockers.length === 0,
      blockers,
      notes: [],
      plugins: [],
      checkedAt: 1,
    })
    const dependsOn = (id: string) => ({
      kind: "depends-on" as const,
      item: { kind: "connector-instance" as const, id },
      label: id,
    })
    const resolved = resolveBatchDependencies([
      preflight("connector-instance", "ready-conn", []),
      preflight("connector-instance", "blocked-conn", [{ kind: "host-too-old" }]),
      preflight("bot-installation", "rides", [dependsOn("ready-conn")]),
      preflight("bot-installation", "waits", [dependsOn("blocked-conn")]),
    ])
    expect(resolved.find((p) => p.item.id === "rides")).toMatchObject({ ready: true, blockers: [] })
    expect(resolved.find((p) => p.item.id === "waits")).toMatchObject({ ready: false })
  })
})
