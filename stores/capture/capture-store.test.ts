import { useCaptureStore } from "./capture-store"
import type { CaptureCandidate } from "@/types/capture"

const candidate: CaptureCandidate = { kind: "text", text: "hi", fingerprint: "fp" }

beforeEach(() => useCaptureStore.getState().clear())

describe("useCaptureStore", () => {
  it("requests and clears a pending candidate", () => {
    expect(useCaptureStore.getState().pending).toBeNull()
    useCaptureStore.getState().request(candidate)
    expect(useCaptureStore.getState().pending).toBe(candidate)
    useCaptureStore.getState().clear()
    expect(useCaptureStore.getState().pending).toBeNull()
  })
})
