import {
  createCaptureSource,
  wireCaptureSource,
  type CapturePersistedEvent,
} from "./capture-source"
import { useCaptureStore } from "@/stores/capture/capture-store"
import type { CaptureCandidate } from "@/types/capture"

const candidate: CaptureCandidate = {
  kind: "text",
  text: "private clipboard text",
  fingerprint: "private-fingerprint",
}

describe("createCaptureSource", () => {
  it("links the confirmation wait and persisted milestone without content leakage", () => {
    let pending: CaptureCandidate | null = null
    let onPending: () => void = () => {
      throw new Error("Pending subscriber was not wired")
    }
    let onPersisted: (event: CapturePersistedEvent) => void = () => {
      throw new Error("Persisted subscriber was not wired")
    }
    const disposePending = jest.fn()
    const disposePersisted = jest.fn()
    const emit = jest.fn()
    const wire = createCaptureSource({
      getPending: () => pending,
      subscribePending: (listener) => {
        onPending = listener
        return disposePending
      },
      subscribePersisted: (listener) => {
        onPersisted = listener
        return disposePersisted
      },
    })

    const stop = wire(emit)
    pending = candidate
    onPending()
    pending = { ...candidate, kind: "url" }
    onPending()
    pending = null
    onPending()
    onPersisted({ captureId: "cap-1", kind: "text", capturedAt: 100 })

    expect(emit.mock.calls).toEqual([
      [
        {
          source: "capture",
          kind: "waiting",
          xp: 0,
          meta: { captureKind: "text", pending: true },
        },
      ],
      [
        {
          source: "capture",
          kind: "idle",
          xp: 0,
          meta: { pending: false },
        },
      ],
      [
        {
          source: "capture",
          kind: "success",
          xp: 1,
          meta: { captureId: "cap-1", captureKind: "text" },
        },
      ],
    ])
    expect(JSON.stringify(emit.mock.calls)).not.toContain("private clipboard text")
    expect(JSON.stringify(emit.mock.calls)).not.toContain("private-fingerprint")

    stop()
    expect(disposePending).toHaveBeenCalledTimes(1)
    expect(disposePersisted).toHaveBeenCalledTimes(1)
  })

  it("surfaces a confirmation already pending at mount", () => {
    const emit = jest.fn()
    const wire = createCaptureSource({
      getPending: () => candidate,
      subscribePending: () => () => {},
      subscribePersisted: () => () => {},
    })

    wire(emit)

    expect(emit).toHaveBeenCalledWith({
      source: "capture",
      kind: "waiting",
      xp: 0,
      meta: { captureKind: "text", pending: true },
    })
  })

  it("uses the production pending-store subscription and detaches cleanly", () => {
    useCaptureStore.getState().clear()
    const emit = jest.fn()
    const stop = wireCaptureSource(emit)

    useCaptureStore.getState().request(candidate)
    useCaptureStore.getState().clear()
    expect(emit.mock.calls.map(([event]) => event.kind)).toEqual(["waiting", "idle"])

    stop()
    useCaptureStore.getState().request(candidate)
    expect(emit).toHaveBeenCalledTimes(2)
    useCaptureStore.getState().clear()
  })
})
