import {
  __resetHostEventPublisherForTests,
  getHostEventPublisher,
  publishHostEvent,
  setHostEventPublisher,
} from "./host-event-publisher"

const emitMock = jest.fn(() => Promise.resolve())
jest.mock("@tauri-apps/api/event", () => ({
  __esModule: true,
  emit: (...args: unknown[]) => emitMock(...(args as [])),
}))

jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: jest.fn(() => false),
}))
import { isTauri } from "@/lib/platform/detect"
const isTauriMock = isTauri as jest.Mock

describe("host-event-publisher", () => {
  beforeEach(() => {
    __resetHostEventPublisherForTests()
    emitMock.mockClear()
    isTauriMock.mockReturnValue(false)
  })

  it("is a no-op outside Tauri when no publisher is registered", async () => {
    await expect(publishHostEvent("sync://invalidate", { table: "x" })).resolves.toBeUndefined()
    expect(emitMock).not.toHaveBeenCalled()
  })

  it("routes to the registered publisher first, even under Tauri", async () => {
    isTauriMock.mockReturnValue(true)
    const publisher = jest.fn()
    setHostEventPublisher(publisher)
    await publishHostEvent("connector://message-added", { messageId: "m1" })
    expect(publisher).toHaveBeenCalledWith("connector://message-added", { messageId: "m1" })
    expect(emitMock).not.toHaveBeenCalled()
  })

  it("falls back to Tauri emit on the desktop webview", async () => {
    isTauriMock.mockReturnValue(true)
    await publishHostEvent("sync://invalidate", { table: "outboundQueue" })
    expect(emitMock).toHaveBeenCalledWith("sync://invalidate", { table: "outboundQueue" })
  })

  it("swallows publisher failures (best-effort)", async () => {
    setHostEventPublisher(() => {
      throw new Error("bridge down")
    })
    await expect(publishHostEvent("sync://invalidate", {})).resolves.toBeUndefined()
  })

  it("swallows Tauri emit failures", async () => {
    isTauriMock.mockReturnValue(true)
    emitMock.mockRejectedValueOnce(new Error("no window"))
    await expect(publishHostEvent("sync://invalidate", {})).resolves.toBeUndefined()
  })

  it("unregister only clears the slot when it still holds the same publisher", () => {
    const first = jest.fn()
    const second = jest.fn()
    const unregisterFirst = setHostEventPublisher(first)
    setHostEventPublisher(second)
    unregisterFirst()
    expect(getHostEventPublisher()).toBe(second)
    setHostEventPublisher(null)
    expect(getHostEventPublisher()).toBeNull()
  })
})
