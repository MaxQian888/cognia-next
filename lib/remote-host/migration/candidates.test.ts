import type { ItemMigrationRow } from "@/lib/db/item-migrations"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { BotInstallationRow } from "@/lib/db/bot-types"
import type { ItemOwnerRemoteHost } from "@/types/placement/item-owner"
import type { ScheduledTask } from "@/types/scheduler"

import { buildAlwaysOnWork, type AlwaysOnSources } from "./candidates"

const onMini = (remoteItemId: string): ItemOwnerRemoteHost => ({
  kind: "remote-host",
  hostId: "mini",
  hostLabel: "Mac mini",
  remoteItemId,
  operationId: "op",
  movedAt: 1,
})

function task(id: string, name: string, extra: Partial<ScheduledTask> = {}): ScheduledTask {
  return { id, name, type: "chat", ...extra } as ScheduledTask
}

function migration(overrides: Partial<ItemMigrationRow>): ItemMigrationRow {
  return {
    operationId: "op",
    direction: "move",
    itemKind: "scheduled-task",
    itemId: "t1",
    itemLabel: "Digest",
    hostId: "mini",
    hostLabel: "Mac mini",
    localStatus: "active",
    state: "completed",
    history: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function sources(overrides: Partial<AlwaysOnSources> = {}): AlwaysOnSources {
  return {
    tasks: [],
    bots: [],
    botNames: new Map(),
    connectors: [],
    migrations: [],
    ...overrides,
  }
}

describe("buildAlwaysOnWork", () => {
  it("offers what runs here, connectors first, and leaves out a Bot's own tasks", () => {
    const work = buildAlwaysOnWork(
      sources({
        tasks: [
          task("t2", "Zebra report"),
          task("t1", "Digest"),
          task("tb", "Bot tick", { type: "bot" }),
        ],
        bots: [{ id: "b1", definitionId: "acme.helper" } as BotInstallationRow],
        botNames: new Map([["acme.helper", "Helper"]]),
        connectors: [{ id: "c1", displayName: "Team Telegram" } as AdapterInstanceRow],
      }),
      "mini"
    )
    expect(work.local.map((item) => [item.ref.kind, item.label])).toEqual([
      ["connector-instance", "Team Telegram"],
      ["bot-installation", "Helper"],
      ["scheduled-task", "Digest"],
      ["scheduled-task", "Zebra report"],
    ])
    expect(work.movedHere).toEqual([])
  })

  it("lists what this host runs for us, and nothing another host runs", () => {
    const work = buildAlwaysOnWork(
      sources({
        tasks: [
          task("t1", "Digest", { owner: onMini("t1") }),
          task("t2", "Elsewhere", { owner: { ...onMini("t2"), hostId: "vps" } }),
          task("t3", "Pinned", {
            owner: { kind: "this-device", reason: "manual", pinnedAt: 1 },
          }),
        ],
      }),
      "mini"
    )
    expect(work.movedHere.map((item) => item.ref.id)).toEqual(["t1"])
    expect(work.local.map((item) => item.ref.id)).toEqual(["t3"])
  })

  it("shows an item's latest operation with this host only while it is unfinished", () => {
    const work = buildAlwaysOnWork(
      sources({
        migrations: [
          migration({ operationId: "a", itemId: "t1", state: "failed", createdAt: 1 }),
          migration({ operationId: "b", itemId: "t1", state: "completed", createdAt: 2 }),
          migration({ operationId: "c", itemId: "t2", state: "awaiting-host", createdAt: 3 }),
          migration({ operationId: "d", itemId: "t3", state: "fenced", hostId: "vps" }),
        ],
      }),
      "mini"
    )
    expect(work.unfinished.map((row) => row.operationId)).toEqual(["c"])
  })
})
