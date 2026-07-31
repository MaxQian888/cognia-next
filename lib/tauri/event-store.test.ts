/**
 * @jest-environment jsdom
 */

const isTauriMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

type Handler = (e: { payload: unknown }) => void
const handlers = new Map<string, Handler>()
const unlistenSpies = new Map<string, jest.Mock>()
// When set, `listen` parks its resolve here so a test can detach mid-subscribe.
let deferListen: ((resume: () => void) => void) | null = null
jest.mock("@tauri-apps/api/event", () => ({
  listen: (topic: string, handler: Handler) => {
    handlers.set(topic, handler)
    const un = jest.fn(() => handlers.delete(topic))
    unlistenSpies.set(topic, un)
    if (deferListen) {
      const park = deferListen
      return new Promise<() => void>((resolve) => park(() => resolve(un)))
    }
    return Promise.resolve(un)
  },
}))

import { createTauriEventStore } from "./event-store"

interface Snap {
  generatedAt: number
  items: string[]
}

const EMPTY: Snap = { generatedAt: 0, items: [] }
const EVENT = "test://update"

const flush = () => new Promise((r) => setTimeout(r, 0))

function makeStore(overrides: Partial<Parameters<typeof createTauriEventStore<Snap>>[0]> = {}) {
  return createTauriEventStore<Snap>({
    event: EVENT,
    initial: EMPTY,
    ...overrides,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  handlers.clear()
  unlistenSpies.clear()
  deferListen = null
  isTauriMock.mockReturnValue(true)
})

describe("createTauriEventStore", () => {
  it("is inert off Tauri: no listen, unsubscribe is a no-op", async () => {
    isTauriMock.mockReturnValue(false)
    const store = makeStore()
    const unsub = store.subscribe(jest.fn())
    await flush()
    expect(handlers.size).toBe(0)
    expect(store.getSnapshot()).toBe(EMPTY)
    unsub()
  })

  it("lazily listens on the first subscriber only", async () => {
    const store = makeStore()
    expect(handlers.size).toBe(0)
    const unsubA = store.subscribe(jest.fn())
    const unsubB = store.subscribe(jest.fn())
    await flush()
    expect(handlers.size).toBe(1)
    unsubA()
    unsubB()
  })

  it("replaces the snapshot on events and notifies subscribers", async () => {
    const store = makeStore()
    const onChange = jest.fn()
    const unsub = store.subscribe(onChange)
    await flush()
    handlers.get(EVENT)!({ payload: { generatedAt: 5, items: ["a"] } })
    expect(store.getSnapshot().items).toEqual(["a"])
    expect(onChange).toHaveBeenCalledTimes(1)
    unsub()
  })

  it("applies a custom applyEvent fold", async () => {
    const store = makeStore({
      applyEvent: (current, payload) => ({
        generatedAt: (payload as Snap).generatedAt,
        items: [...current.items, ...(payload as Snap).items],
      }),
    })
    const unsub = store.subscribe(jest.fn())
    await flush()
    handlers.get(EVENT)!({ payload: { generatedAt: 1, items: ["a"] } })
    handlers.get(EVENT)!({ payload: { generatedAt: 2, items: ["b"] } })
    expect(store.getSnapshot().items).toEqual(["a", "b"])
    unsub()
  })

  it("keeps snapshot identity stable between events", async () => {
    const store = makeStore()
    const unsub = store.subscribe(jest.fn())
    await flush()
    handlers.get(EVENT)!({ payload: { generatedAt: 1, items: ["a"] } })
    const first = store.getSnapshot()
    expect(store.getSnapshot()).toBe(first)
    unsub()
  })

  it("backfills after listen and applies the monotonic guard", async () => {
    let resolveBackfill: (v: Snap) => void = () => {}
    const store = makeStore({
      backfill: () => new Promise<Snap>((r) => (resolveBackfill = r)),
      applyBackfill: (current, fetched) =>
        current.generatedAt >= fetched.generatedAt ? current : fetched,
    })
    const unsub = store.subscribe(jest.fn())
    await flush()
    // Live event lands before the slow backfill resolves with OLDER data.
    handlers.get(EVENT)!({ payload: { generatedAt: 500, items: ["live"] } })
    resolveBackfill({ generatedAt: 400, items: ["stale"] })
    await flush()
    expect(store.getSnapshot().generatedAt).toBe(500)
    unsub()
  })

  it("backfill replaces an older snapshot", async () => {
    const store = makeStore({
      backfill: () => Promise.resolve({ generatedAt: 100, items: ["fresh"] }),
      applyBackfill: (current, fetched) =>
        current.generatedAt >= fetched.generatedAt ? current : fetched,
    })
    const unsub = store.subscribe(jest.fn())
    await flush()
    expect(store.getSnapshot().items).toEqual(["fresh"])
    unsub()
  })

  it("unlistens when the last subscriber detaches", async () => {
    const store = makeStore()
    const unsubA = store.subscribe(jest.fn())
    const unsubB = store.subscribe(jest.fn())
    await flush()
    unsubA()
    expect(unlistenSpies.get(EVENT)).not.toHaveBeenCalled()
    unsubB()
    expect(unlistenSpies.get(EVENT)).toHaveBeenCalledTimes(1)
  })

  it("handles unsubscribe-before-listen-resolves: unlistens and skips backfill", async () => {
    let resumeListen: (() => void) | undefined
    deferListen = (resume) => {
      resumeListen = resume
    }
    const backfill = jest.fn().mockResolvedValue(EMPTY)
    const store = makeStore({ backfill })
    const unsub = store.subscribe(jest.fn())
    await flush()
    expect(resumeListen).toBeDefined()
    unsub() // last subscriber gone while listen() still pending
    resumeListen!()
    await flush()
    expect(unlistenSpies.get(EVENT)).toHaveBeenCalled()
    expect(backfill).not.toHaveBeenCalled()
  })

  it("re-attaches (and re-backfills) on a cold re-subscribe", async () => {
    const backfill = jest.fn().mockResolvedValue({ generatedAt: 1, items: ["x"] } satisfies Snap)
    const store = makeStore({ backfill })
    const unsubA = store.subscribe(jest.fn())
    await flush()
    unsubA()
    const unsubB = store.subscribe(jest.fn())
    await flush()
    expect(backfill).toHaveBeenCalledTimes(2)
    unsubB()
  })

  it("double-calling an unsubscribe does not tear down a newer generation", async () => {
    const store = makeStore()
    const unsubA = store.subscribe(jest.fn())
    await flush()
    unsubA()
    const unsubB = store.subscribe(jest.fn())
    await flush()
    unsubA() // stale double-call must be inert
    expect(handlers.has(EVENT)).toBe(true)
    unsubB()
  })

  it("getServerSnapshot always returns the initial value", async () => {
    const store = makeStore()
    const unsub = store.subscribe(jest.fn())
    await flush()
    handlers.get(EVENT)!({ payload: { generatedAt: 9, items: ["z"] } })
    expect(store.getServerSnapshot()).toBe(EMPTY)
    unsub()
  })

  it("resetForTests drops listeners and restores the initial snapshot", async () => {
    const store = makeStore()
    store.subscribe(jest.fn())
    await flush()
    handlers.get(EVENT)!({ payload: { generatedAt: 9, items: ["z"] } })
    store.resetForTests()
    expect(store.getSnapshot()).toBe(EMPTY)
    expect(unlistenSpies.get(EVENT)).toHaveBeenCalled()
  })
})
