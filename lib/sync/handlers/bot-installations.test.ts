/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { BotInstallationRow } from "@/lib/db/bot-types"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"

const pendingIds = jest.fn(async () => new Set<string>())
jest.mock("@/lib/bot/control-writes/pending-installations", () => ({
  pendingBotInstallationIds: () => pendingIds(),
}))

import {
  applyBotInstallationRows,
  normalizeMirroredInstallation,
  syncBotInstallations,
} from "./bot-installations"

function makeTransport(rows: BotInstallationRow[] = []): Transport {
  return {
    call: jest.fn(async () => ({
      rows,
      deleted_ids: [],
      next_since: 21,
    })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

function installation(id: string, over: Partial<BotInstallationRow> = {}): BotInstallationRow {
  return {
    id,
    definitionId: "acme:digest",
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
    status: "enabled",
    config: {},
    credentialBindings: {},
    createdAt: 10,
    updatedAt: 20,
    ...over,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  pendingIds.mockClear().mockResolvedValue(new Set<string>())
})

describe("normalizeMirroredInstallation", () => {
  it("forces the projection shape even when the Host sent more", () => {
    // The "a mirror never drives a local scheduler" invariant must not depend
    // on the Host having applied its own projection.
    const row = normalizeMirroredInstallation(
      installation("boti_1", {
        config: { channel: "#ops" },
        credentialBindings: { gh: { integrationAccountId: "iacc_1" } },
        triggerState: { cron: { watermark: 99 } },
      })
    )
    expect(row.config).toEqual({})
    expect(row.credentialBindings).toEqual({})
    expect(row.syncedFromHost).toBe(true)
  })

  it("deletes triggerState rather than emptying it", () => {
    // `{}` reads as "this installation has a runner state and it is blank",
    // and a poll cursor read from that is the one that rewinds the Host.
    const row = normalizeMirroredInstallation(
      installation("boti_1", { triggerState: { cron: { watermark: 99 } } })
    )
    expect("triggerState" in row).toBe(false)
  })

  it("keeps the fields the console renders", () => {
    const row = normalizeMirroredInstallation(
      installation("boti_1", {
        status: "needs_setup",
        triggerOverrides: { cron: false },
        workspaceId: "ws_1",
      })
    )
    expect(row).toMatchObject({
      id: "boti_1",
      definitionId: "acme:digest",
      status: "needs_setup",
      triggerOverrides: { cron: false },
      workspaceId: "ws_1",
    })
  })
})

describe("applyBotInstallationRows", () => {
  it("writes the normalized row", async () => {
    await applyBotInstallationRows([installation("boti_1", { config: { a: 1 } })])
    const stored = await getDb().botInstallations.get("boti_1")
    expect(stored?.config).toEqual({})
    expect(stored?.syncedFromHost).toBe(true)
  })

  it("skips an installation with an in-flight relayed mutation", async () => {
    // The client flipped the trigger optimistically and shipped the write
    // through the durable queue. A delta that predates the Host applying it
    // would flip the switch back under the user's finger.
    await getDb().botInstallations.put(
      installation("boti_1", { triggerOverrides: { cron: true }, syncedFromHost: true })
    )
    pendingIds.mockResolvedValue(new Set(["boti_1"]))
    await applyBotInstallationRows([installation("boti_1", { triggerOverrides: { cron: false } })])
    const stored = await getDb().botInstallations.get("boti_1")
    expect(stored?.triggerOverrides).toEqual({ cron: true })
  })

  it("still writes the installations that are NOT pending", async () => {
    pendingIds.mockResolvedValue(new Set(["boti_1"]))
    await applyBotInstallationRows([installation("boti_1"), installation("boti_2")])
    expect(await getDb().botInstallations.get("boti_1")).toBeUndefined()
    expect(await getDb().botInstallations.get("boti_2")).toBeDefined()
  })

  it("does not ask for the pending set when there is nothing to write", async () => {
    await applyBotInstallationRows([])
    expect(pendingIds).not.toHaveBeenCalled()
  })
})

describe("syncBotInstallations", () => {
  it("pulls the table and mirrors the projection", async () => {
    const tx = makeTransport([installation("boti_1", { config: { secret: true } })])
    const out = await syncBotInstallations(tx, { since: 0 })
    expect(tx.call).toHaveBeenCalledWith(
      "sync_pull",
      expect.objectContaining({ table: "botInstallations", since: 0 })
    )
    expect(out.ok).toBe(true)
    expect((await getDb().botInstallations.get("boti_1"))?.config).toEqual({})
  })
})

it("checks cancellation after pending installation resolution", async () => {
  const write = jest.spyOn(getDb().botInstallations, "bulkPut")
  try {
    await expect(
      applyBotInstallationRows([installation("stale")], () => {
        throw new Error("cancelled")
      })
    ).rejects.toThrow("cancelled")
    expect(write).not.toHaveBeenCalled()
  } finally {
    write.mockRestore()
  }
})
