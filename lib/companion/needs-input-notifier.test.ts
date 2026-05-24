/**
 * @jest-environment jsdom
 */

import { notifyRemoteNeedsInput } from "./needs-input-notifier"

const emitMock = jest.fn().mockResolvedValue(undefined)

jest.mock("@tauri-apps/api/event", () => ({
  emit: (event: string, payload: unknown) => emitMock(event, payload),
}))

const TAURI_KEY = "__TAURI_INTERNALS__"
function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

beforeEach(() => {
  emitMock.mockClear()
})
afterEach(() => {
  setTauri(false)
})

describe("notifyRemoteNeedsInput", () => {
  it("emits companion://needs-input with the payload under Tauri", async () => {
    setTauri(true)
    await notifyRemoteNeedsInput({ sessionId: "s1", requestId: "r1", toolName: "write" })
    expect(emitMock).toHaveBeenCalledWith("companion://needs-input", {
      sessionId: "s1",
      requestId: "r1",
      toolName: "write",
    })
  })

  it("is a no-op when not running under Tauri", async () => {
    setTauri(false)
    await notifyRemoteNeedsInput({ sessionId: "s1", requestId: "r1", toolName: "write" })
    expect(emitMock).not.toHaveBeenCalled()
  })

  it("swallows emit failures", async () => {
    setTauri(true)
    emitMock.mockRejectedValueOnce(new Error("transport down"))
    await expect(
      notifyRemoteNeedsInput({ sessionId: "s1", requestId: "r1", toolName: "write" })
    ).resolves.toBeUndefined()
  })
})
