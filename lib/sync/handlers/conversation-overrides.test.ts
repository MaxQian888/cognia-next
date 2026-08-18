/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import {
  __resetPendingOverridesForTests,
  markPendingOverrideMutation,
} from "@/lib/connectors/inbox-writes/pending-overrides"
import { setActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import { enqueue } from "@/lib/db/mobile-outbound-queue"

import { applyConversationOverrideRows, syncConversationOverrides } from "./conversation-overrides"

function makeTransport(rows: ConversationOverrideRow[] = []): Transport {
  return {
    call: jest.fn(async () => ({
      rows,
      deleted_ids: [],
      next_since: 21,
    })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

function row(conversationKey: string, over: Partial<ConversationOverrideRow> = {}): ConversationOverrideRow {
  return {
    id: `cov-${conversationKey}`,
    conversationKey,
    sessionId: "s1",
    createdAt: 1,
    updatedAt: 2,
    ...over,
  }
}

describe("syncConversationOverrides", () => {
  beforeEach(async () => {
    __resetPendingOverridesForTests()
    await getDb().delete()
    __resetDbForTesting()
    setActiveRuntimeTargetContext("acct-test", "mobile-companion")
  })

  it("calls sync_pull with table=conversationOverrides", async () => {
    const tx = makeTransport()
    const out = await syncConversationOverrides(tx, { since: 0 })

    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "conversationOverrides",
      since: 0,
      content_protocol_version: 1,
    })
    expect(out.ok).toBe(true)
  })

  it("applies pulled rows to Dexie", async () => {
    const tx = makeTransport([row("telegram:a:1", { mode: "auto" })])
    const out = await syncConversationOverrides(tx, { since: 0 })
    expect(out.ok).toBe(true)
    const stored = await getDb().conversationOverrides.where("conversationKey").equals("telegram:a:1").first()
    expect(stored?.mode).toBe("auto")
  })

  it("skips rows whose conversation has an in-flight relayed mutation (memory marker)", async () => {
    await getDb().conversationOverrides.put(row("telegram:a:1", { mode: "manual", updatedAt: 5 }))
    const release = markPendingOverrideMutation("telegram:a:1")
    await applyConversationOverrideRows([
      row("telegram:a:1", { mode: "auto" }),
      row("telegram:a:2", { mode: "draft" }),
    ])
    const kept = await getDb().conversationOverrides.where("conversationKey").equals("telegram:a:1").first()
    expect(kept?.mode).toBe("manual")
    const other = await getDb().conversationOverrides.where("conversationKey").equals("telegram:a:2").first()
    expect(other?.mode).toBe("draft")
    release()
    // Marker released → the next pull lands the host's row.
    await applyConversationOverrideRows([row("telegram:a:1", { mode: "auto" })])
    const replaced = await getDb().conversationOverrides.where("conversationKey").equals("telegram:a:1").first()
    expect(replaced?.mode).toBe("auto")
  })

  it("skips rows whose conversation has an unfinished conversation_overrides_update queue row", async () => {
    await getDb().conversationOverrides.put(row("telegram:a:9", { pinned: true, updatedAt: 5 }))
    await enqueue({
      command: "conversation_overrides_update",
      payload: { mutation: { kind: "setPinned", conversationKey: "telegram:a:9", pinned: true } },
    })
    await applyConversationOverrideRows([row("telegram:a:9", { pinned: false })])
    const kept = await getDb().conversationOverrides.where("conversationKey").equals("telegram:a:9").first()
    expect(kept?.pinned).toBe(true)
  })
})
