import { invoke } from "@tauri-apps/api/core"
import { startMatrixSync, type MatrixRoomEvent } from "./transport-sync"
import type { MatrixTimelineEvent } from "./parse"

const mockInvoke = invoke as jest.Mock

function syncResp(
  nextBatch: string,
  joinRooms: Record<string, { timeline?: { events?: MatrixTimelineEvent[] } }>
) {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ next_batch: nextBatch, rooms: { join: joinRooms } }),
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
})
