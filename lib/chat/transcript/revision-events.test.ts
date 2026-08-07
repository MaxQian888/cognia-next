/** @jest-environment jsdom */

import { isTauri } from "@/lib/platform/detect"
import { publishTranscriptRevision } from "./revision-events"

const emit = jest.fn()
jest.mock("@/lib/platform/detect", () => ({ isTauri: jest.fn(() => false) }))
jest.mock("@tauri-apps/api/event", () => ({ emit: (...args: unknown[]) => emit(...args) }))

describe("publishTranscriptRevision", () => {
  it("dispatches a local event without requiring Tauri", async () => {
    const listener = jest.fn()
    window.addEventListener("transcript://revision", listener)

    await publishTranscriptRevision("s1", 4)

    expect(listener).toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    window.removeEventListener("transcript://revision", listener)
  })

  it("forwards the bounded revision envelope through Tauri", async () => {
    ;(isTauri as jest.Mock).mockReturnValueOnce(true)

    await publishTranscriptRevision("s1", 5)

    expect(emit).toHaveBeenCalledWith("transcript://revision", {
      sessionId: "s1",
      revision: 5,
    })
  })
})
