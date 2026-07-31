const callMock = jest.fn()
const subscribeMock = jest.fn()

jest.mock("@/lib/tauri", () => ({
  transport: {
    call: (...args: unknown[]) => callMock(...args),
    subscribe: (...args: unknown[]) => subscribeMock(...args),
  },
}))

import {
  onRecordEvent,
  recordCancel,
  recordStart,
  recordStatus,
  recordStop,
} from "./recorder-client"

beforeEach(() => {
  callMock.mockReset().mockResolvedValue(undefined)
  subscribeMock.mockReset()
})

describe("recorder-client", () => {
  it("record_start wraps args under the `args` key", async () => {
    callMock.mockResolvedValue({ recording: true, stepCount: 0 })
    await recordStart({ inlineScreenshots: true, maxWidth: 1024 })
    expect(callMock).toHaveBeenCalledWith("record_start", {
      args: { inlineScreenshots: true, maxWidth: 1024 },
    })
  })

  it("record_start defaults to an empty args object", async () => {
    await recordStart()
    expect(callMock).toHaveBeenCalledWith("record_start", { args: {} })
  })

  it("record_stop / record_status / record_cancel call their commands", async () => {
    await recordStop()
    await recordStatus()
    await recordCancel()
    expect(callMock).toHaveBeenCalledWith("record_stop")
    expect(callMock).toHaveBeenCalledWith("record_status")
    expect(callMock).toHaveBeenCalledWith("record_cancel")
  })

  it("onRecordEvent subscribes to the record:event channel and returns the unlisten fn", () => {
    const unlisten = jest.fn()
    subscribeMock.mockReturnValue(unlisten)
    const handler = jest.fn()
    const off = onRecordEvent(handler)
    expect(subscribeMock).toHaveBeenCalledWith("record:event", handler)
    expect(off).toBe(unlisten)
  })
})
