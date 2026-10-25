import {
  __resetOutboundAskStoreForTesting,
  requestOutboundAsk,
  useOutboundAskStore,
} from "./outbound-ask-store"

const QUESTION = {
  site: "https://forms.example.com",
  basis: "request" as const,
  operation: "POST",
  asker: "chat" as const,
  forRequestOffered: true,
}

beforeEach(() => {
  jest.useFakeTimers()
  __resetOutboundAskStoreForTesting()
})
afterEach(() => jest.useRealTimers())

describe("outbound ask store", () => {
  it("asks nobody when no dialog is mounted", () => {
    expect(requestOutboundAsk(QUESTION, { ttlMs: 1_000 })).toBeNull()
  })

  it("queues a question until the dialog answers it", async () => {
    const unmount = useOutboundAskStore.getState().mountHost()
    const asked = requestOutboundAsk(QUESTION, { ttlMs: 60_000, now: () => 10, newId: () => "q1" })
    expect(useOutboundAskStore.getState().entries).toEqual([
      { ...QUESTION, id: "q1", createdAt: 10, expiresAt: 60_010 },
    ])
    useOutboundAskStore.getState().answer("q1", "request")
    await expect(asked).resolves.toBe("request")
    expect(useOutboundAskStore.getState().entries).toEqual([])
    // A second answer to the same question changes nothing.
    useOutboundAskStore.getState().answer("q1", "refuse")
    unmount()
    expect(useOutboundAskStore.getState().hosts).toBe(0)
  })

  it("shows questions oldest first", () => {
    useOutboundAskStore.getState().mountHost()
    let id = 0
    void requestOutboundAsk(QUESTION, { ttlMs: 60_000, newId: () => `q${++id}` })
    void requestOutboundAsk(
      { ...QUESTION, operation: "WS" },
      { ttlMs: 60_000, newId: () => `q${++id}` }
    )
    expect(useOutboundAskStore.getState().entries.map((entry) => entry.id)).toEqual(["q1", "q2"])
  })

  it("expires an unanswered question", async () => {
    useOutboundAskStore.getState().mountHost()
    const asked = requestOutboundAsk(QUESTION, { ttlMs: 5_000 })
    jest.advanceTimersByTime(5_000)
    await expect(asked).resolves.toBe("expired")
    expect(useOutboundAskStore.getState().entries).toEqual([])
  })

  it("withdraws a question its caller gave up on", async () => {
    useOutboundAskStore.getState().mountHost()
    const controller = new AbortController()
    const asked = requestOutboundAsk(QUESTION, { ttlMs: 60_000, signal: controller.signal })
    controller.abort()
    await expect(asked).resolves.toBe("withdrawn")
    expect(useOutboundAskStore.getState().entries).toEqual([])
    const already = requestOutboundAsk(QUESTION, { ttlMs: 60_000, signal: controller.signal })
    await expect(already).resolves.toBe("withdrawn")
  })

  it("counts each mounted dialog once, however often it unmounts", () => {
    const first = useOutboundAskStore.getState().mountHost()
    const second = useOutboundAskStore.getState().mountHost()
    first()
    first()
    expect(useOutboundAskStore.getState().hosts).toBe(1)
    second()
    expect(useOutboundAskStore.getState().hosts).toBe(0)
  })
})
