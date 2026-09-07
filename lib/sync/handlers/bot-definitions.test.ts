/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { BotDefinitionRow } from "@/lib/db/bot-types"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"

import { syncBotDefinitions } from "./bot-definitions"

function makeTransport(rows: BotDefinitionRow[], deletedIds: string[] = []): Transport {
  return {
    call: jest.fn(async () => ({
      rows,
      deleted_ids: deletedIds,
      next_since: 21,
    })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

function definition(id: string, over: Partial<BotDefinitionRow> = {}): BotDefinitionRow {
  return {
    id,
    name: "Local digest",
    version: "0.1.0",
    executor: "agent-turn",
    prompt: "summarise the day",
    triggers: [{ id: "cron", kind: "schedule", cron: "0 9 * * *" }],
    createdAt: 10,
    updatedAt: 20,
    ...over,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

describe("syncBotDefinitions", () => {
  it("mirrors the whole row, because none of it is a secret", () => {
    // A definition names an executor, triggers, a policy ceiling and the
    // credential SLOTS it needs, never a credential.
    const tx = makeTransport([
      definition("bdef_1", {
        requires: { credentials: [{ id: "gh", label: "GitHub" }] },
        policy: { maxRunCostUsd: 2 },
      }),
    ])
    return syncBotDefinitions(tx, { since: 0 }).then(async (out) => {
      expect(out.ok).toBe(true)
      const stored = await getDb().botDefinitions.get("bdef_1")
      expect(stored).toMatchObject({
        prompt: "summarise the day",
        requires: { credentials: [{ id: "gh", label: "GitHub" }] },
        policy: { maxRunCostUsd: 2 },
      })
    })
  })

  it("asks for the right table", async () => {
    const tx = makeTransport([])
    await syncBotDefinitions(tx, { since: 7 })
    expect(tx.call).toHaveBeenCalledWith(
      "sync_pull",
      expect.objectContaining({ table: "botDefinitions", since: 7 })
    )
  })

  it("applies a tombstone, so a deleted definition stops being named", async () => {
    await getDb().botDefinitions.put(definition("bdef_gone"))
    await syncBotDefinitions(makeTransport([], ["bdef_gone"]), { since: 0 })
    expect(await getDb().botDefinitions.get("bdef_gone")).toBeUndefined()
  })
})
