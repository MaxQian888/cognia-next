/** @jest-environment jsdom */
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/tauri/events", () => ({ onTauriEvent: jest.fn() }))
jest.mock("@/lib/tauri/safe-unlisten", () => ({ safeUnlisten: jest.fn((fn: () => void) => fn()) }))
jest.mock("@/lib/browser/recording/replayer", () => ({ replayFlow: jest.fn() }))
jest.mock("@/lib/browser/client", () => ({
  browserClient: {
    embedStartRecord: jest.fn().mockResolvedValue("1"),
    embedResumeRecord: jest.fn().mockResolvedValue("1"),
    embedStopRecord: jest.fn().mockResolvedValue("1"),
    embedDrainRecord: jest.fn().mockResolvedValue([]),
  },
}))

import { act, renderHook, waitFor } from "@testing-library/react"

import { browserClient } from "@/lib/browser/client"
import { BROWSER_EVENTS } from "@/lib/browser/protocol"
import type { RecordedFlow } from "@/lib/browser/recording/protocol"
import { replayFlow } from "@/lib/browser/recording/replayer"
import { isTauri } from "@/lib/tauri"
import { onTauriEvent } from "@/lib/tauri/events"
import { useFlowRecorder } from "./use-flow-recorder"

const onEvent = onTauriEvent as jest.Mock
const replay = replayFlow as jest.Mock
const drainRecord = browserClient.embedDrainRecord as jest.Mock
const resumeRecord = browserClient.embedResumeRecord as jest.Mock

/** What the mocked `replayFlow` settles with. */
type ReplayResult = { ok: boolean; steps: never[] }

const BASE = "http://localhost:3000"
const handlers = new Map<string, (payload: unknown) => void>()
const unlisten = jest.fn()
const now = () => 1000

function flow(over: Partial<RecordedFlow> = {}): RecordedFlow {
  return { id: "f1", name: "login", baseUrl: BASE, createdAt: 0, updatedAt: 0, steps: [], ...over }
}

beforeEach(() => {
  handlers.clear()
  unlisten.mockClear()
  drainRecord.mockReset().mockResolvedValue([])
  resumeRecord.mockReset().mockResolvedValue("1")
  replay.mockReset().mockResolvedValue({ ok: true, steps: [] })
  onEvent.mockReset().mockImplementation(async (event: string, handler: (p: unknown) => void) => {
    handlers.set(event, handler)
    return unlisten
  })
})

function emit(event: string, payload: unknown) {
  handlers.get(event)?.(payload)
}

describe("recording lifecycle", () => {
  it("starts disarmed", () => {
    const { result } = renderHook(() => useFlowRecorder({ now }))
    expect(result.current.recording).toBe(false)
    expect(result.current.steps).toEqual([])
  })

  it("arms the page and seeds the base url", async () => {
    const { result } = renderHook(() => useFlowRecorder({ now }))
    await act(() => result.current.start(BASE))
    expect(result.current.recording).toBe(true)
    expect(result.current.steps).toEqual([{ act: "navigate", at: 0, url: BASE }])
  })

  it("stops and hands back the finished flow", async () => {
    const { result } = renderHook(() => useFlowRecorder({ now }))
    await act(() => result.current.start(BASE))
    let finished: RecordedFlow | null = null
    await act(async () => {
      finished = await result.current.stop()
    })
    expect(finished).toMatchObject({ baseUrl: BASE, createdAt: 1000 })
    expect(result.current.recording).toBe(false)
  })

  it("falls back to the wall clock when no clock is injected", async () => {
    const before = Date.now()
    const { result } = renderHook(() => useFlowRecorder())
    await act(() => result.current.start(BASE))
    let finished: RecordedFlow | null = null
    await act(async () => {
      finished = await result.current.stop()
    })
    expect(finished!.createdAt).toBeGreaterThanOrEqual(before)
    expect(finished!.id).toMatch(/^flow_\d+$/)
  })

  it("returns null when stopping without a take", async () => {
    const { result } = renderHook(() => useFlowRecorder({ now }))
    let finished: RecordedFlow | null = flow()
    await act(async () => {
      finished = await result.current.stop()
    })
    expect(finished).toBeNull()
  })
})

describe("pane events", () => {
  it("records a navigation the pane reports", async () => {
    const { result } = renderHook(() => useFlowRecorder({ now }))
    await waitFor(() => expect(handlers.has(BROWSER_EVENTS.navigated)).toBe(true))
    await act(() => result.current.start(BASE))
    act(() => emit(BROWSER_EVENTS.navigated, { paneId: "p", url: `${BASE}/next` }))
    expect(result.current.steps).toHaveLength(2)
    expect(result.current.steps[1]).toMatchObject({ act: "navigate", url: `${BASE}/next` })
  })

  it("drains and re-arms the page on load — the buffer would otherwise be lost", async () => {
    drainRecord.mockResolvedValue([
      { act: "click", at: 1, target: { selector: "#go", role: "button", name: "Go", domPath: "" } },
    ])
    const { result } = renderHook(() => useFlowRecorder({ now }))
    await waitFor(() => expect(handlers.has(BROWSER_EVENTS.loaded)).toBe(true))
    await act(() => result.current.start(BASE))
    await act(async () => {
      emit(BROWSER_EVENTS.loaded, { paneId: "p", url: BASE })
      await Promise.resolve()
    })
    await waitFor(() => expect(resumeRecord).toHaveBeenCalled())
    expect(result.current.steps.some((s) => s.act === "click")).toBe(true)
  })

  it("ignores pane events outside a take", async () => {
    renderHook(() => useFlowRecorder({ now }))
    await waitFor(() => expect(handlers.has(BROWSER_EVENTS.loaded)).toBe(true))
    act(() => emit(BROWSER_EVENTS.loaded, { paneId: "p", url: BASE }))
    expect(resumeRecord).not.toHaveBeenCalled()
  })

  // The pane also renders in the browser/mobile shells, where there is no
  // embedded webview and no Tauri event bus to subscribe to.
  it("subscribes to nothing outside Tauri", async () => {
    ;(isTauri as jest.Mock).mockReturnValueOnce(false)
    renderHook(() => useFlowRecorder({ now }))
    await Promise.resolve()
    expect(onEvent).not.toHaveBeenCalled()
  })

  it("unsubscribes on unmount", async () => {
    const { unmount } = renderHook(() => useFlowRecorder({ now }))
    await waitFor(() => expect(onEvent).toHaveBeenCalledTimes(2))
    unmount()
    expect(unlisten).toHaveBeenCalled()
  })

  // A take that outlives the pane leaves the page armed with nobody draining it.
  it("cancels an in-flight take on unmount", async () => {
    const { result, unmount } = renderHook(() => useFlowRecorder({ now }))
    await act(() => result.current.start(BASE))
    unmount()
    await waitFor(() => expect(browserClient.embedStopRecord).toHaveBeenCalled())
  })
})

describe("editing", () => {
  it("appends an assertion", async () => {
    const { result } = renderHook(() => useFlowRecorder({ now }))
    await act(() => result.current.start(BASE))
    act(() => result.current.addAssertion("Welcome"))
    expect(result.current.steps[1]).toMatchObject({ act: "wait_for", text: "Welcome" })
  })

  it("removes a step", async () => {
    const { result } = renderHook(() => useFlowRecorder({ now }))
    await act(() => result.current.start(BASE))
    act(() => result.current.removeStep(0))
    expect(result.current.steps).toEqual([])
  })
})

describe("replay", () => {
  it("reports success and raises then clears the in-flight flag", async () => {
    let settle: (r: ReplayResult) => void = () => {}
    replay.mockImplementation(() => new Promise<ReplayResult>((resolve) => (settle = resolve)))
    const { result } = renderHook(() => useFlowRecorder({ now }))
    let done: Promise<boolean> | undefined
    act(() => {
      done = result.current.replay(flow())
    })
    // Observed while parked — asserting only the cleared state would pass
    // against a hook that never raised the flag at all.
    expect(result.current.replaying).toBe(true)

    let ok = false
    await act(async () => {
      settle({ ok: true, steps: [] })
      ok = (await done) as boolean
    })
    expect(ok).toBe(true)
    expect(result.current.replaying).toBe(false)
  })

  it("surfaces per-step progress", async () => {
    const step = {
      act: "click",
      at: 1,
      target: { selector: "#a", role: null, name: null, domPath: null },
    }
    replay.mockImplementation(
      async (_f: RecordedFlow, _e: unknown, opts: { onStep?: (r: unknown) => void }) => {
        opts.onStep?.({ index: 0, step, ok: false, error: "boom" })
        return { ok: false, steps: [] }
      }
    )
    const { result } = renderHook(() => useFlowRecorder({ now }))
    await act(async () => {
      await result.current.replay(flow())
    })
    expect(result.current.replayProgress).toMatchObject({ index: 0, ok: false, error: "boom" })
  })

  it("forwards secrets to the replayer", async () => {
    const { result } = renderHook(() => useFlowRecorder({ now }))
    await act(async () => {
      await result.current.replay(flow(), { PASSWORD: "hunter2" })
    })
    expect(replay).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ secrets: { PASSWORD: "hunter2" } })
    )
  })

  it("clears the in-flight flag even when the replayer throws", async () => {
    let fail: (e: Error) => void = () => {}
    replay.mockImplementation(
      () => new Promise<ReplayResult>((_resolve, reject) => (fail = reject))
    )
    const { result } = renderHook(() => useFlowRecorder({ now }))
    let done: Promise<boolean> | undefined
    act(() => {
      done = result.current.replay(flow())
    })
    expect(result.current.replaying).toBe(true)

    await act(async () => {
      fail(new Error("pane closed"))
      await expect(done).rejects.toThrow("pane closed")
    })
    expect(result.current.replaying).toBe(false)
  })

  // `replay`'s finally nulls out abortRef, so a replay that has already settled
  // can no longer be aborted — the abort has to land while it is parked.
  it("aborts an in-flight replay", async () => {
    let signal: AbortSignal | undefined
    let settle: (r: ReplayResult) => void = () => {}
    replay.mockImplementation(
      (_f: RecordedFlow, _e: unknown, opts: { signal: AbortSignal }) =>
        new Promise<ReplayResult>((resolve) => {
          signal = opts.signal
          settle = resolve
        })
    )
    const { result } = renderHook(() => useFlowRecorder({ now }))
    let done: Promise<boolean> | undefined
    act(() => {
      done = result.current.replay(flow())
    })
    expect(signal).toBeDefined()
    expect(signal!.aborted).toBe(false)

    act(() => result.current.stopReplay())
    expect(signal!.aborted).toBe(true)

    await act(async () => {
      settle({ ok: false, steps: [] })
      await done
    })
  })

  it("lists the secrets a flow needs", () => {
    const { result } = renderHook(() => useFlowRecorder({ now }))
    const withSecret = flow({
      steps: [
        {
          act: "fill",
          at: 1,
          target: { selector: "#pw", role: "textbox", name: "Password", domPath: null },
          value: "",
          secret: true,
        },
      ],
    })
    expect(result.current.secretsFor(withSecret)).toEqual(["PASSWORD"])
  })
})
