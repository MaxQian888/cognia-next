/** @jest-environment jsdom */
// Drives the hook against the REAL registry (only the Dexie read is mocked) so
// the refcount bookkeeping is exercised end to end. The double-release case
// below is the reason this file exists: it is invisible to a mocked registry.

import { act, renderHook, waitFor } from "@testing-library/react"

import { useMediaUrl } from "./use-media-url"
import { __TESTING__, acquireMedia } from "@/lib/chat/media/resolve-media"
import { getMessageMedia, mediaRef } from "@/lib/db/message-media"

jest.mock("@/lib/db/message-media", () => {
  const actual = jest.requireActual("@/lib/db/message-media")
  return { ...actual, getMessageMedia: jest.fn() }
})

const getMedia = getMessageMedia as jest.MockedFunction<typeof getMessageMedia>

let revoked: string[] = []
let urlCounter = 0

beforeEach(() => {
  __TESTING__.reset()
  getMedia.mockReset()
  revoked = []
  urlCounter = 0
  URL.createObjectURL = jest.fn(() => `blob:mock/${urlCounter++}`)
  URL.revokeObjectURL = jest.fn((url: string) => revoked.push(url))
  getMedia.mockResolvedValue({
    hash: "h",
    mediaType: "image/jpeg",
    width: 1568,
    height: 980,
    blob: { size: 1_000 } as unknown as Blob,
    byteSize: 1_000,
    createdAt: 1,
    lastUsedAt: 1,
  } as Awaited<ReturnType<typeof getMessageMedia>>)
})

describe("useMediaUrl", () => {
  it("stays inactive for a non-reference", async () => {
    const { result } = renderHook(() => useMediaUrl("data:image/png;base64,AAAA"))

    expect(result.current.status).toBe("inactive")
    expect(result.current.url).toBeNull()
    expect(getMedia).not.toHaveBeenCalled()
  })

  it("stays inactive for null", () => {
    const { result } = renderHook(() => useMediaUrl(null))

    expect(result.current.status).toBe("inactive")
  })

  it("resolves a reference to a URL and its geometry", async () => {
    const { result } = renderHook(() => useMediaUrl(mediaRef("h")))

    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.url).toBe("blob:mock/0")
    expect(result.current.width).toBe(1568)
    expect(result.current.height).toBe(980)
  })

  it("reports a dangling reference as missing", async () => {
    getMedia.mockResolvedValue(undefined)

    const { result } = renderHook(() => useMediaUrl(mediaRef("gone")))

    await waitFor(() => expect(result.current.status).toBe("missing"))
    expect(result.current.url).toBeNull()
  })

  it("releases its holder on unmount", async () => {
    const { result, unmount } = renderHook(() => useMediaUrl(mediaRef("h")))
    await waitFor(() => expect(result.current.status).toBe("ready"))

    expect(__TESTING__.stats().holders).toBe(1)
    unmount()
    expect(__TESTING__.stats().holders).toBe(0)
  })

  it("swaps holders when the reference changes", async () => {
    const { result, rerender } = renderHook(({ ref }) => useMediaUrl(ref), {
      initialProps: { ref: mediaRef("a") },
    })
    await waitFor(() => expect(result.current.status).toBe("ready"))

    rerender({ ref: mediaRef("b") })
    await waitFor(() => expect(result.current.status).toBe("ready"))

    // One holder at a time, not two.
    expect(__TESTING__.stats().holders).toBe(1)
  })

  it("does not release another component's holder when it unmounts mid-flight", async () => {
    // The regression this guards: `acquireMedia` increments synchronously for
    // an already-resolved reference, so an unmount before the promise settles
    // used to release twice — and the second release revoked a URL the other
    // component's <img> was still using.
    const held = await acquireMedia(mediaRef("h"))
    expect(held).not.toBeNull()
    expect(__TESTING__.stats().holders).toBe(1)

    const { unmount } = renderHook(() => useMediaUrl(mediaRef("h")))
    // Unmount in the same tick, before the acquire promise settles.
    unmount()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(__TESTING__.stats().holders).toBe(1)
    expect(revoked).toEqual([])
  })

  it("releases the holder it acquired after unmounting mid-flight", async () => {
    const { unmount } = renderHook(() => useMediaUrl(mediaRef("h")))
    unmount()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Nothing pinned: the mid-flight acquire's holder was handed back.
    expect(__TESTING__.stats().holders).toBe(0)
  })

  it("asks for the thumbnail when told to", async () => {
    getMedia.mockResolvedValue({
      hash: "h",
      mediaType: "image/jpeg",
      width: 1568,
      height: 980,
      blob: { size: 1_000 } as unknown as Blob,
      byteSize: 1_000,
      thumbBlob: { size: 80 } as unknown as Blob,
      thumbWidth: 512,
      thumbHeight: 320,
      createdAt: 1,
      lastUsedAt: 1,
    } as Awaited<ReturnType<typeof getMessageMedia>>)

    const { result } = renderHook(() => useMediaUrl(mediaRef("h"), { thumbnail: true }))

    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.isThumbnail).toBe(true)
    expect(result.current.width).toBe(512)
  })
})
