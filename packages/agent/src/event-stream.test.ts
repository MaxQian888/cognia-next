import { BackpressureError } from "./errors"
import { SessionEventHub, type ReplayPage, type ReplayReader } from "./event-stream"
import type { AgentEventEnvelope } from "./types"

function envelope(id: string, sequence = 0): AgentEventEnvelope {
  return { eventId: id, sequence, event: { kind: "text" } }
}

function emptyReader(): ReplayReader {
  return async () => ({ entries: [] })
}

/** A reader that serves a fixed history in pages and reports a stable head. */
function historyReader(ids: readonly string[], pageSize = 512): ReplayReader {
  return async ({ afterEventId, limit }) => {
    const start = afterEventId ? ids.indexOf(afterEventId) + 1 : 0
    const size = Math.min(limit, pageSize)
    const slice = ids.slice(start, start + size)
    const page: ReplayPage = {
      entries: slice.map((id) => ({ envelope: envelope(id) })),
      ...(ids.length > 0 ? { headEventId: ids[ids.length - 1] } : {}),
      ...(start + slice.length < ids.length ? { nextEventId: slice[slice.length - 1] } : {}),
    }
    return page
  }
}

async function take(stream: AsyncIterable<AgentEventEnvelope>, count: number): Promise<string[]> {
  const out: string[] = []
  for await (const event of stream) {
    out.push(event.eventId)
    if (out.length >= count) break
  }
  return out
}

describe("SessionEventHub", () => {
  it("gives every subscriber the full stream instead of splitting it", async () => {
    const hub = new SessionEventHub(emptyReader())
    const first = hub.subscribe({ replay: false })
    const second = hub.subscribe({ replay: false })

    hub.publish(envelope("a"))
    hub.publish(envelope("b"))
    hub.publish(envelope("c"))

    await expect(take(first, 3)).resolves.toEqual(["a", "b", "c"])
    await expect(take(second, 3)).resolves.toEqual(["a", "b", "c"])
  })

  it("replays history before live events and does not interleave them", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const reader: ReplayReader = async ({ afterEventId }) => {
      await gate
      return afterEventId
        ? { entries: [], headEventId: "h2" }
        : {
            entries: [{ envelope: envelope("h1") }, { envelope: envelope("h2") }],
            headEventId: "h2",
          }
    }
    const hub = new SessionEventHub(reader)
    const stream = hub.subscribe()

    // Live events arrive while replay is still in flight.
    hub.publish(envelope("live1"))
    hub.publish(envelope("live2"))
    release()

    await expect(take(stream, 4)).resolves.toEqual(["h1", "h2", "live1", "live2"])
  })

  it("deduplicates an event that appears in both the replay page and the live buffer", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const reader: ReplayReader = async () => {
      await gate
      return {
        entries: [{ envelope: envelope("h1") }, { envelope: envelope("overlap") }],
        headEventId: "overlap",
      }
    }
    const hub = new SessionEventHub(reader)
    const stream = hub.subscribe()

    hub.publish(envelope("overlap"))
    hub.publish(envelope("after"))
    release()

    await expect(take(stream, 3)).resolves.toEqual(["h1", "overlap", "after"])
  })

  it("pages history until the head cursor is reached", async () => {
    const ids = Array.from({ length: 1300 }, (_, index) => `e${index}`)
    const hub = new SessionEventHub(historyReader(ids))
    const stream = hub.subscribe({ capacity: 4096 })
    const seen = await take(stream, ids.length)
    expect(seen).toHaveLength(1300)
    expect(seen[0]).toBe("e0")
    expect(seen.at(-1)).toBe("e1299")
  })

  it("resumes from a caller cursor and skips everything before it", async () => {
    const ids = ["e0", "e1", "e2", "e3"]
    const hub = new SessionEventHub(historyReader(ids))
    const stream = hub.subscribe({ afterEventId: "e1" })
    await expect(take(stream, 2)).resolves.toEqual(["e2", "e3"])
  })

  it("skips replay entirely when the caller asks for live-only delivery", async () => {
    const reader = jest.fn(historyReader(["old"]))
    const hub = new SessionEventHub(reader)
    const stream = hub.subscribe({ replay: false })
    hub.publish(envelope("new"))
    await expect(take(stream, 1)).resolves.toEqual(["new"])
    expect(reader).not.toHaveBeenCalled()
  })

  it("closes only the overflowing subscriber and leaves siblings intact", async () => {
    const hub = new SessionEventHub(emptyReader())
    const slow = hub.subscribe({ replay: false, capacity: 2 })
    const fast = hub.subscribe({ replay: false, capacity: 64 })

    for (let index = 0; index < 6; index += 1) hub.publish(envelope(`e${index}`))

    const drain = async () => {
      const out: string[] = []
      for await (const event of slow) out.push(event.eventId)
      return out
    }
    await expect(drain()).rejects.toBeInstanceOf(BackpressureError)
    // The sibling is still registered after the slow subscriber self-destructs.
    expect(hub.subscriberCount).toBe(1)
    await expect(take(fast, 6)).resolves.toEqual(["e0", "e1", "e2", "e3", "e4", "e5"])
  })

  it("reports the last delivered event id on the backpressure error", async () => {
    const hub = new SessionEventHub(emptyReader())
    const stream = hub.subscribe({ replay: false, capacity: 2 })
    const iterator = stream[Symbol.asyncIterator]()

    hub.publish(envelope("a"))
    await iterator.next()
    for (const id of ["b", "c", "d", "e"]) hub.publish(envelope(id))

    // b and c fill the queue; d overflows it.
    await iterator.next()
    await iterator.next()
    await expect(iterator.next()).rejects.toMatchObject({
      code: "backpressure_exceeded",
      lastEventId: "c",
      capacity: 2,
    })
  })

  it("surfaces a replay failure to the subscriber that asked for it", async () => {
    const hub = new SessionEventHub(async () => {
      throw new Error("event log unreadable")
    })
    const stream = hub.subscribe()
    const iterator = stream[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow("event log unreadable")
  })

  it("ends the iterator when the caller's signal aborts", async () => {
    const hub = new SessionEventHub(emptyReader())
    const controller = new AbortController()
    const stream = hub.subscribe({ replay: false, signal: controller.signal })
    const iterator = stream[Symbol.asyncIterator]()
    const pending = iterator.next()
    controller.abort()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    expect(hub.subscriberCount).toBe(0)
  })

  it("drops a subscriber from the fan-out when its iterator returns early", async () => {
    const hub = new SessionEventHub(emptyReader())
    const stream = hub.subscribe({ replay: false })
    hub.publish(envelope("a"))
    await take(stream, 1)
    expect(hub.subscriberCount).toBe(0)
  })

  it("closes every subscriber when the hub closes", async () => {
    const hub = new SessionEventHub(emptyReader())
    const stream = hub.subscribe({ replay: false })
    const iterator = stream[Symbol.asyncIterator]()
    const pending = iterator.next()
    hub.close()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
  })

  it("hands a post-close subscriber an immediately finished stream", async () => {
    const hub = new SessionEventHub(emptyReader())
    hub.close()
    const stream = hub.subscribe({ replay: false })
    await expect(take(stream, 1)).resolves.toEqual([])
  })

  it("bounds the live buffer while replay is still paging", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const hub = new SessionEventHub(async () => {
      await gate
      return { entries: [], headEventId: undefined }
    })
    const stream = hub.subscribe({ capacity: 2 })
    const iterator = stream[Symbol.asyncIterator]()
    for (const id of ["a", "b", "c"]) hub.publish(envelope(id))
    release()
    await expect(iterator.next()).rejects.toBeInstanceOf(BackpressureError)
  })
})
