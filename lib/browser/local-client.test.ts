type Handler = (payload: unknown) => void
const mockInvoke = jest.fn()
const channels: Array<{ onmessage?: (message: unknown) => void }> = []
const subscribers = new Map<string, Handler>()

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  Channel: class {
    onmessage: ((message: unknown) => void) | undefined
    constructor() {
      channels.push(this)
    }
  },
}))

jest.mock("@/lib/tauri", () => ({
  transport: {
    call: jest.fn(),
    subscribe: jest.fn((event: string, handler: Handler) => {
      subscribers.set(event, handler)
      return () => subscribers.delete(event)
    }),
  },
}))

import { transport } from "@/lib/tauri"
import {
  LOCAL_BROWSER_EVENTS,
  localBrowser,
  toFrameBytes,
  type LocalBrowserEvent,
} from "./local-client"

const call = transport.call as jest.Mock

beforeEach(() => {
  call.mockReset()
  mockInvoke.mockReset()
  mockInvoke.mockResolvedValue(undefined)
  channels.length = 0
  subscribers.clear()
})

it("maps lifecycle calls onto the local runtime commands", async () => {
  call.mockResolvedValue({ installed: true, running: true })
  await localBrowser.status()
  await localBrowser.install()
  await localBrowser.uninstall()
  await localBrowser.start()
  await localBrowser.stop()
  await localBrowser.discoverUserChrome()
  expect(call.mock.calls.map(([name]) => name)).toEqual([
    "browser_local_status",
    "browser_local_install",
    "browser_local_uninstall",
    "browser_local_start",
    "browser_local_stop",
    "browser_user_chrome_discover",
  ])
})

it("sends runtime ops through the allow-listed rpc command", async () => {
  call.mockResolvedValueOnce({ url: "https://a.test", title: "A" })
  await expect(localBrowser.rpc("browser.page", { sessionId: "s" })).resolves.toEqual({
    url: "https://a.test",
    title: "A",
  })
  expect(call).toHaveBeenCalledWith("browser_local_rpc", {
    op: "browser.page",
    payload: { sessionId: "s" },
  })
})

it("starts the runtime before creating a session when it is not running", async () => {
  call
    .mockResolvedValueOnce({ running: false })
    .mockResolvedValueOnce({ running: true })
    .mockResolvedValueOnce({ id: "s1" })
  await expect(localBrowser.createSession({ id: "s1", kind: "local" })).resolves.toEqual({
    id: "s1",
  })
  expect(call.mock.calls.map(([name]) => name)).toEqual([
    "browser_local_status",
    "browser_local_start",
    "browser_local_rpc",
  ])
  expect(call.mock.calls[2][1]).toEqual({
    op: "browser.session.create",
    payload: { id: "s1", kind: "local" },
  })
})

it("streams frames through a Channel and unsubscribes once", async () => {
  const frames: Uint8Array[] = []
  const stop = await localBrowser.subscribeFrames("s1", (bytes) => frames.push(bytes))
  expect(mockInvoke).toHaveBeenCalledWith("browser_local_frames_subscribe", {
    sessionId: "s1",
    channel: channels[0],
  })
  channels[0].onmessage?.([1, 2, 3])
  channels[0].onmessage?.(new Uint8Array([4]).buffer)
  channels[0].onmessage?.("garbage")
  expect(frames.map((f) => [...f])).toEqual([[1, 2, 3], [4]])
  stop()
  stop()
  channels[0].onmessage?.([9])
  expect(frames).toHaveLength(2)
  expect(mockInvoke).toHaveBeenCalledTimes(2)
  expect(mockInvoke).toHaveBeenLastCalledWith("browser_local_frames_unsubscribe", {
    sessionId: "s1",
  })
})

it("filters runtime events to the known vocabulary", async () => {
  const seen: LocalBrowserEvent[] = []
  const unlisten = await localBrowser.onEvent((event) => seen.push(event))
  const handler = subscribers.get(LOCAL_BROWSER_EVENTS.event)!
  handler({ type: "pages.changed", sessionId: "s1" })
  handler({ type: "runtime.operation", sessionId: "s1" })
  handler(null)
  expect(seen).toEqual([{ type: "pages.changed", sessionId: "s1" }])
  unlisten()
  expect(subscribers.has(LOCAL_BROWSER_EVENTS.event)).toBe(false)
})

it("forwards install progress", async () => {
  const progress: unknown[] = []
  await localBrowser.onInstallProgress((p) => progress.push(p))
  subscribers.get(LOCAL_BROWSER_EVENTS.install)!({ phase: "downloading", receivedBytes: 5 })
  expect(progress).toEqual([{ phase: "downloading", receivedBytes: 5 }])
})

describe("toFrameBytes", () => {
  it("normalizes every Channel payload shape", () => {
    expect([...toFrameBytes(new Uint8Array([1]))!]).toEqual([1])
    expect([...toFrameBytes(new Uint16Array([1]))!]).toEqual([1, 0])
    expect(toFrameBytes({})).toBeNull()
    expect(toFrameBytes(["a"])).toBeNull()
  })
})

describe("uploads", () => {
  it("stages a user pick through Rust and returns the staged paths", async () => {
    call.mockResolvedValueOnce(["/app/browser/uploads/x/cv.pdf"])
    await expect(localBrowser.stageUpload()).resolves.toEqual(["/app/browser/uploads/x/cv.pdf"])
    expect(call).toHaveBeenLastCalledWith("browser_local_stage_upload")
    call.mockResolvedValueOnce([])
    await expect(localBrowser.stageUpload()).resolves.toEqual([])
  })

  it("answers a file chooser through the allow-listed runtime op", async () => {
    call.mockResolvedValueOnce({ ok: true, cancelled: false })
    await expect(localBrowser.answerFileChooser("s1", "c1", ["/u/a"])).resolves.toEqual({
      ok: true,
      cancelled: false,
    })
    expect(call).toHaveBeenLastCalledWith("browser_local_rpc", {
      op: "browser.filechooser.set",
      payload: { sessionId: "s1", chooserId: "c1", paths: ["/u/a"] },
    })
  })

  it("forwards filechooser.opened events", async () => {
    const seen: LocalBrowserEvent[] = []
    await localBrowser.onEvent((event) => seen.push(event))
    const event = {
      type: "filechooser.opened",
      sessionId: "s1",
      pageId: "p1",
      chooserId: "c1",
      multiple: false,
    }
    subscribers.get(LOCAL_BROWSER_EVENTS.event)!(event)
    expect(seen).toEqual([event])
  })
})
