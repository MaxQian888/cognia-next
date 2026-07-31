import { invoke } from "@tauri-apps/api/core"
import { MatrixSyncAuthError, startMatrixSync, type MatrixRoomEvent } from "./transport-sync"
import type { MatrixTimelineEvent } from "./parse"

const mockInvoke = invoke as jest.Mock

function syncResp(
  nextBatch: string,
  joinRooms: Record<
    string,
    { timeline?: { events?: MatrixTimelineEvent[]; limited?: boolean; prev_batch?: string } }
  >,
  extra: { invite?: Record<string, unknown> } = {}
) {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({
      next_batch: nextBatch,
      rooms: { join: joinRooms, ...(extra.invite ? { invite: extra.invite } : {}) },
    }),
  }
}

function textEvent(id: string): MatrixTimelineEvent {
  return {
    type: "m.room.message",
    event_id: id,
    sender: "@alice:s",
    origin_server_ts: 1,
    content: { msgtype: "m.text", body: id },
  }
}

async function drain(
  gen: AsyncGenerator<MatrixRoomEvent>,
  controller: AbortController,
  max: number
) {
  const out: MatrixRoomEvent[] = []
  for await (const e of gen) {
    out.push(e)
    if (out.length >= max) controller.abort()
  }
  return out
}

describe("startMatrixSync", () => {
  beforeEach(() => mockInvoke.mockReset())

  it("discards the priming batch and yields subsequent events", async () => {
    const controller = new AbortController()
    mockInvoke
      .mockResolvedValueOnce(
        syncResp("s1", { "!r:s": { timeline: { events: [textEvent("$priming")] } } })
      )
      .mockResolvedValueOnce(
        syncResp("s2", { "!r:s": { timeline: { events: [textEvent("$live")] } } })
      )
      .mockResolvedValue(syncResp("s3", {}))

    const gen = startMatrixSync({
      homeserver: "matrix.org",
      accessToken: async () => "tok",
      signal: controller.signal,
      _backoffBaseMs: 1,
    })
    const got = await drain(gen, controller, 1)
    expect(got).toHaveLength(1)
    expect(got[0].roomId).toBe("!r:s")
    expect(got[0].event.event_id).toBe("$live")
  })

  it("sends the access token and uses timeout=0 for the priming sync", async () => {
    const controller = new AbortController()
    mockInvoke
      .mockResolvedValueOnce(syncResp("s1", {}))
      .mockResolvedValueOnce(
        syncResp("s2", { "!r:s": { timeline: { events: [textEvent("$x")] } } })
      )
      .mockResolvedValue(syncResp("s3", {}))

    const gen = startMatrixSync({
      homeserver: "matrix.org",
      accessToken: async () => "secret",
      signal: controller.signal,
      _backoffBaseMs: 1,
    })
    await drain(gen, controller, 1)

    const firstReq = mockInvoke.mock.calls[0][1].req
    expect(firstReq.url).toContain("/_matrix/client/v3/sync?")
    expect(firstReq.url).toContain("timeout=0")
    expect(firstReq.url).not.toContain("since=")
    expect(firstReq.headers.Authorization).toBe("Bearer secret")

    const secondReq = mockInvoke.mock.calls[1][1].req
    expect(secondReq.url).toContain("since=s1")
    expect(secondReq.url).toContain("timeout=30000")
  })

  it("backs off then recovers after a 5xx", async () => {
    const controller = new AbortController()
    mockInvoke
      .mockResolvedValueOnce({ status: 502, headers: {}, body: "bad gateway" })
      .mockResolvedValueOnce(syncResp("s1", {}))
      .mockResolvedValueOnce(
        syncResp("s2", { "!r:s": { timeline: { events: [textEvent("$ok")] } } })
      )
      .mockResolvedValue(syncResp("s3", {}))

    const gen = startMatrixSync({
      homeserver: "matrix.org",
      accessToken: async () => "tok",
      signal: controller.signal,
      _backoffBaseMs: 1,
    })
    const got = await drain(gen, controller, 1)
    expect(got).toHaveLength(1)
    expect(got[0].event.event_id).toBe("$ok")
  })

  it("exits immediately when already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const gen = startMatrixSync({
      homeserver: "matrix.org",
      accessToken: async () => "tok",
      signal: controller.signal,
    })
    const got = await drain(gen, controller, 5)
    expect(got).toHaveLength(0)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("sends a lazy-load filter (limit 1 while priming, 20 after) and set_presence=offline", async () => {
    const controller = new AbortController()
    mockInvoke
      .mockResolvedValueOnce(syncResp("s1", {}))
      .mockResolvedValueOnce(
        syncResp("s2", { "!r:s": { timeline: { events: [textEvent("$x")] } } })
      )
      .mockResolvedValue(syncResp("s3", {}))

    const gen = startMatrixSync({
      homeserver: "matrix.org",
      accessToken: async () => "tok",
      signal: controller.signal,
      _backoffBaseMs: 1,
    })
    await drain(gen, controller, 1)

    const firstUrl = decodeURIComponent(mockInvoke.mock.calls[0][1].req.url)
    expect(firstUrl).toContain('"lazy_load_members":true')
    expect(firstUrl).toContain('"timeline":{"limit":1}')
    expect(firstUrl).toContain("set_presence=offline")

    const secondUrl = decodeURIComponent(mockInvoke.mock.calls[1][1].req.url)
    expect(secondUrl).toContain('"timeline":{"limit":20}')
    expect(secondUrl).toContain("set_presence=offline")
  })

  it("resumes from initialSince WITHOUT discarding the first batch, reporting next_batch tokens", async () => {
    const controller = new AbortController()
    mockInvoke
      .mockResolvedValueOnce(
        syncResp("s2", { "!r:s": { timeline: { events: [textEvent("$downtime")] } } })
      )
      .mockResolvedValue(syncResp("s3", {}))

    const tokens: string[] = []
    const gen = startMatrixSync({
      homeserver: "matrix.org",
      accessToken: async () => "tok",
      signal: controller.signal,
      initialSince: "persisted-1",
      onNextBatch: (t) => tokens.push(t),
      _backoffBaseMs: 1,
    })
    const got = await drain(gen, controller, 1)

    expect(got).toHaveLength(1)
    expect(got[0].event.event_id).toBe("$downtime")
    const firstReq = mockInvoke.mock.calls[0][1].req
    expect(firstReq.url).toContain("since=persisted-1")
    // Resumed cursor → long-poll from the first request (no timeout=0 prime).
    expect(firstReq.url).toContain("timeout=30000")
    expect(tokens).toContain("s2")
  })

  it("auto-joins invited rooms once — a failing join does not loop", async () => {
    const controller = new AbortController()
    const warns: string[] = []
    mockInvoke.mockImplementation(async (_cmd: string, args: { req: { url: string } }) => {
      const url = args.req.url
      if (url.includes("/join/")) return { status: 403, headers: {}, body: "{}" }
      // Every sync keeps re-listing the pending invite.
      const n = mockInvoke.mock.calls.filter(([, a]) =>
        String((a as { req: { url: string } }).req.url).includes("/sync")
      ).length
      if (n >= 3) return syncResp("sN", { "!r:s": { timeline: { events: [textEvent("$done")] } } })
      return syncResp(`s${n}`, {}, { invite: { "!inv:server.org": {} } })
    })

    const gen = startMatrixSync({
      homeserver: "matrix.org",
      accessToken: async () => "tok",
      signal: controller.signal,
      logger: { warn: (msg) => warns.push(msg) },
      _backoffBaseMs: 1,
    })
    await drain(gen, controller, 1)

    const joinCalls = mockInvoke.mock.calls.filter(([, a]) =>
      String((a as { req: { url: string } }).req.url).includes("/join/")
    )
    expect(joinCalls).toHaveLength(1)
    expect(joinCalls[0][1].req.url).toContain("/join/" + encodeURIComponent("!inv:server.org"))
    expect(joinCalls[0][1].req.method).toBe("POST")
    expect(warns.some((w) => w.includes("auto-join failed"))).toBe(true)
  })

  it("throws MatrixSyncAuthError on M_UNKNOWN_TOKEN instead of retrying forever", async () => {
    const controller = new AbortController()
    mockInvoke.mockResolvedValue({
      status: 401,
      headers: {},
      body: JSON.stringify({ errcode: "M_UNKNOWN_TOKEN", error: "Invalid token" }),
    })

    const gen = startMatrixSync({
      homeserver: "matrix.org",
      accessToken: async () => "tok",
      signal: controller.signal,
      _backoffBaseMs: 1,
    })
    await expect(drain(gen, controller, 1)).rejects.toThrow(MatrixSyncAuthError)
    // Exactly one request — the loop stopped instead of retrying a dead token.
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })

  it("honors retry_after_ms on a 429 instead of exponential backoff", async () => {
    const controller = new AbortController()
    mockInvoke
      .mockResolvedValueOnce({
        status: 429,
        headers: {},
        body: JSON.stringify({ errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 5 }),
      })
      .mockResolvedValueOnce(syncResp("s1", {}))
      .mockResolvedValueOnce(
        syncResp("s2", { "!r:s": { timeline: { events: [textEvent("$ok")] } } })
      )
      .mockResolvedValue(syncResp("s3", {}))

    const gen = startMatrixSync({
      homeserver: "matrix.org",
      accessToken: async () => "tok",
      signal: controller.signal,
      // A generic backoff would sleep ~60s and time the test out; honoring
      // retry_after_ms (5ms) finishes instantly.
      _backoffBaseMs: 60_000,
    })
    const got = await drain(gen, controller, 1)
    expect(got).toHaveLength(1)
    expect(got[0].event.event_id).toBe("$ok")
  })

  it("backfills a limited timeline gap oldest-first via /messages", async () => {
    const controller = new AbortController()
    mockInvoke.mockImplementation(async (_cmd: string, args: { req: { url: string } }) => {
      const url = args.req.url
      if (url.includes("/messages")) {
        // dir=b pages newest→oldest.
        if (url.includes("from=pb1")) {
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              chunk: [textEvent("$gap2"), textEvent("$gap1")],
              end: "pb2",
            }),
          }
        }
        return { status: 200, headers: {}, body: JSON.stringify({ chunk: [] }) }
      }
      const n = mockInvoke.mock.calls.filter(([, a]) =>
        String((a as { req: { url: string } }).req.url).includes("/sync")
      ).length
      if (n === 1)
        return syncResp("s2", {
          "!r:s": {
            timeline: { events: [textEvent("$new")], limited: true, prev_batch: "pb1" },
          },
        })
      return syncResp(`s${n + 1}`, {})
    })

    const gen = startMatrixSync({
      homeserver: "matrix.org",
      accessToken: async () => "tok",
      signal: controller.signal,
      initialSince: "persisted", // primed from the start
      _backoffBaseMs: 1,
    })
    const got = await drain(gen, controller, 3)

    expect(got.map((e) => e.event.event_id)).toEqual(["$gap1", "$gap2", "$new"])
    const messagesCall = mockInvoke.mock.calls.find(([, a]) =>
      String((a as { req: { url: string } }).req.url).includes("/messages")
    )!
    const url = String((messagesCall[1] as { req: { url: string } }).req.url)
    expect(url).toContain("from=pb1")
    expect(url).toContain("dir=b")
  })

  it("stops the gap backfill at the last already-delivered event", async () => {
    const controller = new AbortController()
    mockInvoke.mockImplementation(async (_cmd: string, args: { req: { url: string } }) => {
      const url = args.req.url
      if (url.includes("/messages")) {
        return {
          status: 200,
          headers: {},
          // newest→oldest: the gap event, then the event we already saw.
          body: JSON.stringify({
            chunk: [textEvent("$gap"), textEvent("$seen"), textEvent("$older")],
            end: "pbX",
          }),
        }
      }
      const n = mockInvoke.mock.calls.filter(([, a]) =>
        String((a as { req: { url: string } }).req.url).includes("/sync")
      ).length
      if (n === 1) return syncResp("s2", { "!r:s": { timeline: { events: [textEvent("$seen")] } } })
      if (n === 2)
        return syncResp("s3", {
          "!r:s": {
            timeline: { events: [textEvent("$new")], limited: true, prev_batch: "pb1" },
          },
        })
      return syncResp(`s${n + 1}`, {})
    })

    const gen = startMatrixSync({
      homeserver: "matrix.org",
      accessToken: async () => "tok",
      signal: controller.signal,
      initialSince: "persisted",
      _backoffBaseMs: 1,
    })
    const got = await drain(gen, controller, 3)

    // $seen delivered by batch 1; the limited batch 2 backfills only $gap
    // (stops at $seen), then delivers $new. $older is never re-delivered.
    expect(got.map((e) => e.event.event_id)).toEqual(["$seen", "$gap", "$new"])
  })
})
