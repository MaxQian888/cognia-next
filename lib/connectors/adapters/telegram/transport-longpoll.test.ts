import { invoke } from "@tauri-apps/api/core"
import { startLongPoll } from "./transport-longpoll"

const mockInvoke = invoke as jest.Mock

function makeUpdate(id: number) {
  return {
    update_id: id,
    message: {
      message_id: id,
      from: { id: 111, first_name: "Test" },
      chat: { id: 111, type: "private" as const },
      date: 1000000,
      text: `msg ${id}`,
    },
  }
}

function makeOkResp(updates: ReturnType<typeof makeUpdate>[]) {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ ok: true, result: updates }),
  }
}

function makeErrResp(status: number) {
  return { status, headers: {}, body: "error" }
}

beforeEach(() => {
  mockInvoke.mockReset()
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

describe("startLongPoll", () => {
  it("yields updates from two polls and advances offset", async () => {
    // Poll 1: 2 updates; Poll 2: 1 update; then we abort
    mockInvoke
      .mockResolvedValueOnce(makeOkResp([makeUpdate(1), makeUpdate(2)])) // poll 1
      .mockResolvedValueOnce(makeOkResp([makeUpdate(3)])) // poll 2
      .mockResolvedValue(makeOkResp([])) // subsequent polls

    const ctrl = new AbortController()
    const updates: number[] = []

    // Collect updates until we abort after getting 3
    for await (const u of startLongPoll({
      botToken: async () => "TOKEN",
      signal: ctrl.signal,
    })) {
      updates.push(u.update_id)
      if (updates.length >= 3) {
        ctrl.abort()
        break
      }
    }

    expect(updates).toEqual([1, 2, 3])

    // Verify offset advances correctly via URL params
    const calls = mockInvoke.mock.calls
    expect(calls[0][1].req.url).toContain("offset=0") // first poll
    expect(calls[1][1].req.url).toContain("offset=3") // after update 1,2 → offset 3
  })

  it("backs off on 5xx error and retries", async () => {
    // Poll 1: 5xx; Poll 2: success
    // Use real timers so we don't need to manually advance fake timers
    jest.useRealTimers()
    mockInvoke
      .mockResolvedValueOnce(makeErrResp(503)) // error
      .mockResolvedValueOnce(makeOkResp([makeUpdate(10)])) // retry success
      .mockResolvedValue(makeOkResp([]))

    const ctrl = new AbortController()
    const updates: number[] = []

    // _backoffBaseMs=1 → 2^1 * 1ms = 2ms backoff — fast enough for a test
    for await (const u of startLongPoll({
      botToken: async () => "TOKEN",
      signal: ctrl.signal,
      _backoffBaseMs: 1,
    })) {
      updates.push(u.update_id)
      ctrl.abort()
      break
    }

    expect(updates).toContain(10)
    // Invoked at least twice — once for error, once for retry
    expect(mockInvoke.mock.calls.length).toBeGreaterThanOrEqual(2)
    // Second call should still use offset=0 (no successful updates yet)
    expect(mockInvoke.mock.calls[1][1].req.url).toContain("offset=0")
  })

  it("stops when signal is aborted before any poll", async () => {
    const ctrl = new AbortController()
    ctrl.abort() // aborted immediately

    const updates: number[] = []
    for await (const u of startLongPoll({
      botToken: async () => "TOKEN",
      signal: ctrl.signal,
    })) {
      updates.push(u.update_id)
    }

    expect(updates).toHaveLength(0)
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})
