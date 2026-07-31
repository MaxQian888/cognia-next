/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

const isTauriMock = jest.fn().mockReturnValue(true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

let eventHandler: ((event: unknown) => void) | null = null
const unlistenMock = jest.fn()
const recordStartMock = jest.fn().mockResolvedValue({ recording: true, stepCount: 0 })
const recordStopMock = jest.fn()
const recordCancelMock = jest.fn().mockResolvedValue(undefined)

jest.mock("@/lib/skills/recording/recorder-client", () => ({
  recordStart: (...a: unknown[]) => recordStartMock(...a),
  recordStop: (...a: unknown[]) => recordStopMock(...a),
  recordCancel: (...a: unknown[]) => recordCancelMock(...a),
  onRecordEvent: (cb: (event: unknown) => void) => {
    eventHandler = cb
    return unlistenMock
  },
}))

import { useSkillRecording } from "./use-skill-recording"

beforeEach(() => {
  isTauriMock.mockReset().mockReturnValue(true)
  eventHandler = null
  unlistenMock.mockClear()
  recordStartMock.mockReset().mockResolvedValue({ recording: true, stepCount: 0 })
  recordStopMock.mockReset()
  recordCancelMock.mockReset().mockResolvedValue(undefined)
})

describe("useSkillRecording", () => {
  it("rejects + flags desktop-only outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    const { result } = renderHook(() => useSkillRecording())
    await act(async () => {
      await expect(result.current.start()).rejects.toThrow(/desktop mode/)
    })
    expect(result.current.error).toBe("desktop-only")
    expect(recordStartMock).not.toHaveBeenCalled()
  })

  it("accumulates step events while recording", async () => {
    const { result } = renderHook(() => useSkillRecording())
    await act(async () => {
      await result.current.start()
    })
    expect(result.current.status).toBe("recording")
    act(() => {
      eventHandler?.({ type: "step", observation: { seq: 1, tsMs: 0, kind: "click" } })
      eventHandler?.({ type: "step", observation: { seq: 2, tsMs: 1, kind: "key" } })
    })
    expect(result.current.steps).toHaveLength(2)
  })

  it("stop returns the trace and detaches the listener", async () => {
    recordStopMock.mockResolvedValue({
      sessionId: "s",
      startedAt: 0,
      endedAt: 1,
      observations: [],
      monitors: [],
    })
    const { result } = renderHook(() => useSkillRecording())
    await act(async () => {
      await result.current.start()
    })
    let trace: unknown
    await act(async () => {
      trace = await result.current.stop()
    })
    expect(trace).toMatchObject({ sessionId: "s" })
    expect(result.current.status).toBe("idle")
    expect(unlistenMock).toHaveBeenCalled()
  })

  it("handles cancelled and unknown record events", async () => {
    const { result } = renderHook(() => useSkillRecording())
    await act(async () => {
      await result.current.start()
    })
    act(() => {
      eventHandler?.({ type: "cancelled" })
    })
    expect(result.current.status).toBe("idle")
    act(() => {
      eventHandler?.({ type: "bogus-event" }) // exercises the default branch
    })
    expect(result.current.status).toBe("idle")
  })

  it("surfaces an error event from the channel", async () => {
    const { result } = renderHook(() => useSkillRecording())
    await act(async () => {
      await result.current.start()
    })
    act(() => {
      eventHandler?.({ type: "error", message: "hook blocked" })
    })
    expect(result.current.status).toBe("error")
    expect(result.current.error).toBe("hook blocked")
  })

  it("cancel resets state and calls the backend", async () => {
    const { result } = renderHook(() => useSkillRecording())
    await act(async () => {
      await result.current.start()
    })
    await act(async () => {
      await result.current.cancel()
    })
    expect(result.current.status).toBe("idle")
    expect(result.current.steps).toHaveLength(0)
    expect(recordCancelMock).toHaveBeenCalled()
  })

  it("surfaces a rejection from recordStart", async () => {
    recordStartMock.mockRejectedValue(new Error("hook blocked"))
    const { result } = renderHook(() => useSkillRecording())
    await act(async () => {
      await expect(result.current.start()).rejects.toThrow(/hook blocked/)
    })
    expect(result.current.status).toBe("error")
    expect(result.current.error).toBe("hook blocked")
    expect(unlistenMock).toHaveBeenCalled() // listener detached on failure
  })

  it("stringifies a non-Error rejection from recordStart", async () => {
    recordStartMock.mockRejectedValue("raw failure")
    const { result } = renderHook(() => useSkillRecording())
    await act(async () => {
      await expect(result.current.start()).rejects.toBeDefined()
    })
    expect(result.current.error).toBe("raw failure")
  })

  it("stringifies a non-Error rejection from recordStop", async () => {
    recordStopMock.mockRejectedValue("raw stop failure")
    const { result } = renderHook(() => useSkillRecording())
    await act(async () => {
      await result.current.start()
    })
    await act(async () => {
      await result.current.stop()
    })
    expect(result.current.error).toBe("raw stop failure")
  })

  it("stop is a no-op when not recording", async () => {
    const { result } = renderHook(() => useSkillRecording())
    let trace: unknown = "sentinel"
    await act(async () => {
      trace = await result.current.stop()
    })
    expect(trace).toBeNull()
    expect(recordStopMock).not.toHaveBeenCalled()
  })

  it("surfaces a recordStop rejection", async () => {
    recordStopMock.mockRejectedValue(new Error("stop failed"))
    const { result } = renderHook(() => useSkillRecording())
    await act(async () => {
      await result.current.start()
    })
    let trace: unknown = "sentinel"
    await act(async () => {
      trace = await result.current.stop()
    })
    expect(trace).toBeNull()
    expect(result.current.status).toBe("error")
    expect(result.current.error).toBe("stop failed")
  })

  it("swallows errors from unlisten and recordCancel during cancel", async () => {
    unlistenMock.mockImplementation(() => {
      throw new Error("unlisten boom")
    })
    recordCancelMock.mockRejectedValue(new Error("cancel boom"))
    const { result } = renderHook(() => useSkillRecording())
    await act(async () => {
      await result.current.start()
    })
    await act(async () => {
      await result.current.cancel() // must not throw despite both failing
    })
    expect(result.current.status).toBe("idle")
  })

  it("detaches the listener on unmount", async () => {
    const { result, unmount } = renderHook(() => useSkillRecording())
    await act(async () => {
      await result.current.start()
    })
    unmount()
    expect(unlistenMock).toHaveBeenCalled()
  })
})
