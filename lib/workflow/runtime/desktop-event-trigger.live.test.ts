/**
 * @jest-environment jsdom
 *
 * Live-subscription coverage for `initDesktopEventTrigger()`.
 *
 * `desktop-event-trigger.test.ts` stubs `getDb()` with a plain array and drives
 * events through `_injectUiaEventForTest`, so the only thing that reconciles
 * there is the deterministic initial `workflows.toArray()` read. The
 * `Dexie.liveQuery` subscription that keeps the backend filters in sync after
 * boot is never exercised, and `initDesktopEventTrigger` swallows a failure
 * into a `log.warn` — so a broken `liveQuery` binding (see the interop note in
 * `lib/db/outbound-jobs.ts`) leaves that suite green while every workflow
 * edited after app start silently stops re-subscribing.
 *
 * These tests therefore assert on reconciles that can ONLY come from the live
 * subscription: writes that land after the initial read has already completed.
 */
import "fake-indexeddb/auto"

jest.mock("./trigger-bridge", () => ({ dispatchTrigger: jest.fn() }))
jest.mock("@/lib/automation/client", () => ({
  desktop: {
    subscribeEvents: jest.fn(async () => 1),
    unsubscribeEvents: jest.fn(async () => undefined),
  },
  listenUiaEvents: jest.fn(async () => jest.fn()),
}))

import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { EventFilter } from "@/lib/automation/types"
import type { WorkflowRow } from "@/types/workflow/visual"

import { disposeDesktopEventTrigger, initDesktopEventTrigger } from "./desktop-event-trigger"

// Constructing the Dexie instance costs ~1s+ per `__resetDbForTesting()` +
// `getDb()` cycle (see the note in lib/db/schema.ts), and the default 5s
// budget is not enough for that hook once the directory runs in parallel.
jest.setTimeout(30_000)

function wf(id: string, params: Record<string, unknown>): WorkflowRow {
  return {
    id,
    schemaVersion: 1,
    name: id,
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      {
        id: `${id}_n1`,
        type: "trigger.desktop.event",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { params },
      },
    ] as WorkflowRow["nodes"],
    edges: [],
    settings: {} as WorkflowRow["settings"],
  }
}

function makeDeps() {
  let nextId = 1
  const subscribe = jest.fn(async (_filter: EventFilter) => nextId++)
  const unsubscribe = jest.fn(async (_id: number) => undefined)
  const listen = jest.fn(async (_handler: unknown) => jest.fn())
  return { subscribe, unsubscribe, listen, now: () => 100_000 }
}

async function until(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

afterEach(() => {
  disposeDesktopEventTrigger()
})

describe("initDesktopEventTrigger (live Dexie subscription)", () => {
  it("subscribes to a workflow written AFTER the initial reconcile", async () => {
    const deps = makeDeps()
    initDesktopEventTrigger(deps)

    // Let the deterministic initial read settle against an empty table, so the
    // reconcile below can only be driven by the liveQuery emission.
    await until(() => deps.listen.mock.calls.length >= 0, "the initial reconcile")
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(deps.subscribe).not.toHaveBeenCalled()

    await getDb().workflows.put(wf("wf_focus", { kinds: ["focus-changed"] }))

    await until(() => deps.subscribe.mock.calls.length === 1, "the liveQuery-driven reconcile")
    expect(deps.subscribe.mock.calls[0][0]).toEqual({ kinds: ["focus-changed"] })
    // The UIA listener is attached lazily, only once a subscription exists.
    expect(deps.listen).toHaveBeenCalledTimes(1)
  })

  it("opens a second backend subscription when a differently-filtered workflow lands", async () => {
    const deps = makeDeps()
    await getDb().workflows.put(wf("wf_focus", { kinds: ["focus-changed"] }))
    initDesktopEventTrigger(deps)
    await until(() => deps.subscribe.mock.calls.length === 1, "the first subscription")

    await getDb().workflows.put(wf("wf_struct", { kinds: ["structure-changed"] }))
    await until(() => deps.subscribe.mock.calls.length === 2, "the second subscription")

    const filters = deps.subscribe.mock.calls.map((call) => call[0])
    expect(filters).toEqual(
      expect.arrayContaining([{ kinds: ["focus-changed"] }, { kinds: ["structure-changed"] }])
    )
  })

  it("releases the backend subscription when the workflow is deleted", async () => {
    const deps = makeDeps()
    await getDb().workflows.put(wf("wf_focus", { kinds: ["focus-changed"] }))
    initDesktopEventTrigger(deps)
    await until(() => deps.subscribe.mock.calls.length === 1, "the first subscription")
    const openedId = await deps.subscribe.mock.results[0].value

    await getDb().workflows.delete("wf_focus")
    await until(() => deps.unsubscribe.mock.calls.length === 1, "the release after delete")
    expect(deps.unsubscribe).toHaveBeenCalledWith(openedId)
  })

  it("releases the subscription when the trigger node is disabled in place", async () => {
    const deps = makeDeps()
    await getDb().workflows.put(wf("wf_focus", { kinds: ["focus-changed"] }))
    initDesktopEventTrigger(deps)
    await until(() => deps.subscribe.mock.calls.length === 1, "the first subscription")

    const disabled = wf("wf_focus", { kinds: ["focus-changed"] })
    disabled.nodes[0].data.disabled = true
    await getDb().workflows.put(disabled)

    await until(() => deps.unsubscribe.mock.calls.length === 1, "the release after disable")
    expect(deps.subscribe).toHaveBeenCalledTimes(1)
  })

  it("stops reconciling once disposed", async () => {
    const deps = makeDeps()
    initDesktopEventTrigger(deps)
    await new Promise((resolve) => setTimeout(resolve, 150))

    disposeDesktopEventTrigger()
    await getDb().workflows.put(wf("wf_focus", { kinds: ["focus-changed"] }))
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(deps.subscribe).not.toHaveBeenCalled()
  })
})
