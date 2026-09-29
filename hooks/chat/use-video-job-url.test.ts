/** @jest-environment jsdom */
import { renderHook, waitFor } from "@testing-library/react"

import { useVideoJobUrl } from "./use-video-job-url"

const readRendererVideo = jest.fn()
jest.mock("@/lib/ai/media/video-jobs/renderer-host", () => ({
  readRendererVideo: (...args: unknown[]) => readRendererVideo(...args),
}))

const createObjectURL = jest.fn(() => "blob:video-1")
const revokeObjectURL = jest.fn()

beforeAll(() => {
  Object.assign(URL, { createObjectURL, revokeObjectURL })
})

beforeEach(() => {
  readRendererVideo.mockReset()
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
})

const content = { kind: "session-asset" as const, sessionId: "s1", assetId: "video-vjob_1" }

describe("useVideoJobUrl", () => {
  it("is idle without content", () => {
    const { result } = renderHook(() => useVideoJobUrl(undefined))
    expect(result.current).toEqual({ status: "idle" })
    expect(readRendererVideo).not.toHaveBeenCalled()
  })

  it("loads the stored video into an object URL and revokes it on unmount", async () => {
    readRendererVideo.mockResolvedValue(new Blob(["v"], { type: "video/mp4" }))
    const { result, unmount } = renderHook(() => useVideoJobUrl(content))
    expect(result.current).toEqual({ status: "loading" })
    await waitFor(() => expect(result.current).toEqual({ status: "ready", url: "blob:video-1" }))
    expect(readRendererVideo).toHaveBeenCalledWith(content)
    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:video-1")
  })

  it("does not reload for a new object naming the same file", async () => {
    readRendererVideo.mockResolvedValue(new Blob(["v"]))
    const { result, rerender } = renderHook(({ c }) => useVideoJobUrl(c), {
      initialProps: { c: content },
    })
    await waitFor(() => expect(result.current.status).toBe("ready"))
    rerender({ c: { ...content } })
    expect(readRendererVideo).toHaveBeenCalledTimes(1)
  })

  it("reports a video that is no longer stored", async () => {
    readRendererVideo.mockRejectedValue(new Error("The video is no longer stored."))
    const { result } = renderHook(() => useVideoJobUrl(content))
    await waitFor(() => expect(result.current).toEqual({ status: "missing" }))
  })
})
