/**
 * @jest-environment jsdom
 *
 * Live-subscription coverage for `initTriggerSubscriptions()`.
 *
 * `trigger-subscriptions.test.ts` seeds the cache through
 * `_seedTriggerSubscriptionsForTest`, which calls `rebuildIndex` directly and
 * never touches Dexie — so nothing there runs the `Dexie.liveQuery` call, and
 * `initTriggerSubscriptions` swallows any failure into a `log.warn`. That
 * combination means a broken `liveQuery` binding (see the interop note in
 * `lib/db/outbound-jobs.ts`) leaves the whole suite green while the trigger
 * index silently never populates on a real device. This file closes that hole
 * by driving the cache exclusively through real Dexie writes.
 */
import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { WorkflowNodeKind, WorkflowRow } from "@/types/workflow/visual"

import {
  disposeTriggerSubscriptions,
  findMatchingWorkflows,
  initTriggerSubscriptions,
} from "./trigger-subscriptions"

// Constructing the Dexie instance costs ~1s+ per `__resetDbForTesting()` +
// `getDb()` cycle (see the note in lib/db/schema.ts), and the default 5s
// budget is not enough for that hook once the directory runs in parallel.
jest.setTimeout(30_000)

function wf(id: string, type: WorkflowNodeKind, params: Record<string, unknown> = {}): WorkflowRow {
  return {
    id,
    schemaVersion: 1,
    name: id,
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      {
        id: `${id}_n1`,
        type,
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { params },
      },
    ] as WorkflowRow["nodes"],
    edges: [],
    settings: {} as WorkflowRow["settings"],
  }
}

/** Poll until `predicate` holds — liveQuery emission timing is scheduler-dependent. */
async function until(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function matchedIds(type: WorkflowNodeKind, ctx: Record<string, unknown> = {}): string[] {
  return findMatchingWorkflows(type, ctx).map((entry) => entry.workflowId)
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

afterEach(() => {
  disposeTriggerSubscriptions()
})

describe("initTriggerSubscriptions (live Dexie subscription)", () => {
  it("populates the cache from the workflows table without any direct seeding", async () => {
    await getDb().workflows.put(wf("wf_live", "trigger.chat.message", { characterId: "char_a" }))

    initTriggerSubscriptions()

    // Nothing else writes this cache in this file — reaching a non-empty index
    // proves `Dexie.liveQuery(...)` was callable, emitted, and reached
    // `rebuildIndex`.
    await until(
      () => matchedIds("trigger.chat.message", { characterId: "char_a" }).length > 0,
      "the initial liveQuery emission"
    )
    expect(matchedIds("trigger.chat.message", { characterId: "char_a" })).toEqual(["wf_live"])
  })

  it("keeps tracking the table after the first emission", async () => {
    initTriggerSubscriptions()
    await getDb().workflows.put(wf("wf_a", "trigger.chat.message"))
    await until(() => matchedIds("trigger.chat.message").length === 1, "the first workflow")

    // A second write must reach the cache too — an initial-read-only
    // implementation would stall at one row.
    await getDb().workflows.put(wf("wf_b", "trigger.chat.message"))
    await until(() => matchedIds("trigger.chat.message").length === 2, "the second workflow")
    expect(matchedIds("trigger.chat.message").sort()).toEqual(["wf_a", "wf_b"])

    // Deletes propagate on the same subscription.
    await getDb().workflows.delete("wf_a")
    await until(() => matchedIds("trigger.chat.message").length === 1, "the delete to propagate")
    expect(matchedIds("trigger.chat.message")).toEqual(["wf_b"])
  })

  it("stops updating once disposed", async () => {
    initTriggerSubscriptions()
    await getDb().workflows.put(wf("wf_a", "trigger.chat.message"))
    await until(() => matchedIds("trigger.chat.message").length === 1, "the first workflow")

    disposeTriggerSubscriptions()
    expect(matchedIds("trigger.chat.message")).toEqual([])

    await getDb().workflows.put(wf("wf_b", "trigger.chat.message"))
    // Give a still-open subscription time to emit; the cache must stay empty.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(matchedIds("trigger.chat.message")).toEqual([])
  })

  it("re-opening after dispose rebuilds from the current table contents", async () => {
    await getDb().workflows.put(wf("wf_a", "trigger.connector.inbound", { adapterId: "tg" }))
    initTriggerSubscriptions()
    await until(
      () => matchedIds("trigger.connector.inbound", { adapterId: "tg" }).length === 1,
      "first open"
    )

    disposeTriggerSubscriptions()
    initTriggerSubscriptions()
    await until(
      () => matchedIds("trigger.connector.inbound", { adapterId: "tg" }).length === 1,
      "the re-opened subscription"
    )
    expect(matchedIds("trigger.connector.inbound", { adapterId: "tg" })).toEqual(["wf_a"])
  })

  it("excludes built-in and template rows written to the real table", async () => {
    await getDb().workflows.bulkPut([
      wf("wf_real", "trigger.chat.message"),
      { ...wf("wf_tpl", "trigger.chat.message"), isTemplate: true },
      { ...wf("wf_builtin", "trigger.chat.message"), isBuiltIn: true },
    ])

    initTriggerSubscriptions()
    await until(() => matchedIds("trigger.chat.message").length > 0, "the liveQuery emission")
    expect(matchedIds("trigger.chat.message")).toEqual(["wf_real"])
  })
})
