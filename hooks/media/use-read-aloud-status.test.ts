import { act, renderHook } from "@testing-library/react"

import { useReadAloudStatus } from "./use-read-aloud-status"
import { ttsOrchestrator } from "@/lib/tts/tts-orchestrator"

// Reach into the singleton's private setState so we can drive state changes
// the way the orchestrator itself would (notifying subscribers).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const setState = (patch: Record<string, unknown>) => (ttsOrchestrator as any).setState(patch)

beforeEach(() => {
  setState({ activeSourceId: undefined, playbackState: "idle", progress: 0 })
})

describe("useReadAloudStatus", () => {
  it("reports inactive/idle by default", () => {
    const { result } = renderHook(() => useReadAloudStatus("msg-1"))
    expect(result.current.isActive).toBe(false)
    expect(result.current.playbackState).toBe("idle")
    expect(result.current.isPlaying).toBe(false)
  })

  it("activates only for the matching message id", () => {
    const { result } = renderHook(() => useReadAloudStatus("msg-1"))
    act(() => setState({ activeSourceId: "msg-2", playbackState: "playing" }))
    expect(result.current.isActive).toBe(false)
    act(() => setState({ activeSourceId: "msg-1", playbackState: "playing" }))
    expect(result.current.isActive).toBe(true)
    expect(result.current.isPlaying).toBe(true)
  })

  it("tracks paused / loading sub-states for the active message", () => {
    const { result } = renderHook(() => useReadAloudStatus("msg-1"))
    act(() => setState({ activeSourceId: "msg-1", playbackState: "loading" }))
    expect(result.current.isLoading).toBe(true)
    act(() => setState({ playbackState: "paused" }))
    expect(result.current.isPaused).toBe(true)
  })

  it("does NOT re-render on progress-only updates (perf guard)", () => {
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useReadAloudStatus("msg-1")
    })
    act(() => setState({ activeSourceId: "msg-1", playbackState: "playing", progress: 0.1 }))
    const after = renders
    expect(result.current.isPlaying).toBe(true)
    // A progress-only change keeps the (active, playbackState) snapshot string
    // identical → useSyncExternalStore bails out → no extra render.
    act(() => setState({ progress: 0.5 }))
    act(() => setState({ progress: 0.9 }))
    expect(renders).toBe(after)
  })

  it("clears when playback stops", () => {
    const { result } = renderHook(() => useReadAloudStatus("msg-1"))
    act(() => setState({ activeSourceId: "msg-1", playbackState: "playing" }))
    expect(result.current.isActive).toBe(true)
    act(() => ttsOrchestrator.stop())
    expect(result.current.isActive).toBe(false)
  })
})
