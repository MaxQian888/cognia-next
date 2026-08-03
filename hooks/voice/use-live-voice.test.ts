import { act, renderHook } from "@testing-library/react"

import type { LiveVoiceController } from "@/lib/voice/live/controller"
import { createInitialLiveVoiceState, type LiveVoiceState } from "@/lib/voice/live/reducer"

import { useLiveVoiceState } from "./use-live-voice"

/** Minimal external store matching the controller's subscribe/getSnapshot pair. */
function fakeController(initial: LiveVoiceState = createInitialLiveVoiceState()) {
  const listeners = new Set<() => void>()
  let state = initial

  return {
    controller: {
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      getSnapshot: () => state,
    } as unknown as LiveVoiceController,
    listenerCount: () => listeners.size,
    push(next: LiveVoiceState) {
      state = next
      for (const listener of listeners) listener()
    },
  }
}

describe("useLiveVoiceState", () => {
  it("returns the controller's current snapshot", () => {
    const store = fakeController({ ...createInitialLiveVoiceState(), phase: "listening" })

    const { result } = renderHook(() => useLiveVoiceState(store.controller))

    expect(result.current.phase).toBe("listening")
  })

  it("re-renders when the controller publishes new state", () => {
    const store = fakeController()
    const { result } = renderHook(() => useLiveVoiceState(store.controller))

    act(() => {
      store.push({ ...createInitialLiveVoiceState(), phase: "responding" })
    })

    expect(result.current.phase).toBe("responding")
  })

  it("reflects turns as they accumulate", () => {
    const store = fakeController()
    const { result } = renderHook(() => useLiveVoiceState(store.controller))

    act(() => {
      store.push({
        ...createInitialLiveVoiceState(),
        turns: [{ id: "u1", role: "user", text: "hello" }],
      })
    })

    expect(result.current.turns).toHaveLength(1)
  })

  it("does not re-render when the snapshot identity is unchanged", () => {
    // The reducer returns the same object for ignored events (audio deltas at
    // ~50/s); a re-render per frame would make the dialog unusable.
    const store = fakeController()
    let renders = 0
    renderHook(() => {
      renders++
      return useLiveVoiceState(store.controller)
    })
    const baseline = renders

    act(() => {
      for (const listener of [1, 2, 3]) {
        void listener
        store.push(store.controller.getSnapshot())
      }
    })

    expect(renders).toBe(baseline)
  })

  it("unsubscribes on unmount", () => {
    const store = fakeController()
    const { unmount } = renderHook(() => useLiveVoiceState(store.controller))
    expect(store.listenerCount()).toBe(1)

    unmount()

    expect(store.listenerCount()).toBe(0)
  })

  it("switches subscription when the controller is replaced", () => {
    const first = fakeController()
    const second = fakeController({ ...createInitialLiveVoiceState(), phase: "connecting" })
    const { result, rerender } = renderHook(
      ({ controller }: { controller: LiveVoiceController }) => useLiveVoiceState(controller),
      { initialProps: { controller: first.controller } }
    )

    rerender({ controller: second.controller })

    expect(result.current.phase).toBe("connecting")
    expect(first.listenerCount()).toBe(0)
    expect(second.listenerCount()).toBe(1)
  })

  describe("without a controller", () => {
    it("renders a stable idle state", () => {
      const { result } = renderHook(() => useLiveVoiceState(null))

      expect(result.current).toMatchObject({
        phase: "idle",
        turns: [],
        assistantDraft: "",
        muted: false,
      })
    })

    it("keeps the same object across re-renders", () => {
      // A fresh object per render triggers React's "getSnapshot should be
      // cached to avoid an infinite loop" invariant.
      const { result, rerender } = renderHook(() => useLiveVoiceState(null))
      const first = result.current

      rerender()

      expect(result.current).toBe(first)
    })

    it("survives being handed a controller later", () => {
      const store = fakeController({ ...createInitialLiveVoiceState(), phase: "listening" })
      const { result, rerender } = renderHook(
        ({ controller }: { controller: LiveVoiceController | null }) =>
          useLiveVoiceState(controller),
        { initialProps: { controller: null as LiveVoiceController | null } }
      )

      rerender({ controller: store.controller })

      expect(result.current.phase).toBe("listening")
    })

    it("survives the controller going away", () => {
      const store = fakeController({ ...createInitialLiveVoiceState(), phase: "listening" })
      const { result, rerender } = renderHook(
        ({ controller }: { controller: LiveVoiceController | null }) =>
          useLiveVoiceState(controller),
        { initialProps: { controller: store.controller as LiveVoiceController | null } }
      )

      rerender({ controller: null })

      expect(result.current.phase).toBe("idle")
      expect(store.listenerCount()).toBe(0)
    })
  })
})
