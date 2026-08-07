/** @jest-environment jsdom */

import { renderHook } from "@testing-library/react"
import type { ReactNode } from "react"

import {
  SessionMediaProvider,
  createSessionMediaLoader,
  useSessionMediaLoader,
} from "./session-media-provider"

const HASH = "a".repeat(64)

describe("session media provider", () => {
  it("does not advertise a loader when the transport lacks binary reads", () => {
    expect(createSessionMediaLoader("session-1", {})).toBeUndefined()
  })

  it("reads canonical bytes through the exact visible session", async () => {
    const readBinary = jest.fn(async () => ({
      bytes: Uint8Array.from([1, 2, 3]),
      mediaType: "image/png",
      etag: HASH,
    }))
    const loader = createSessionMediaLoader("session-visible", { readBinary })

    const row = await loader!({ hash: HASH, variant: "canonical" })

    expect(readBinary).toHaveBeenCalledWith({
      kind: "session-media",
      sessionId: "session-visible",
      hash: HASH,
      variant: "canonical",
    })
    expect(row).toMatchObject({ hash: HASH, mediaType: "image/png", byteSize: 3 })
    expect(row!.blob.size).toBe(3)
  })

  it("marks a fetched thumbnail as a partial cache entry", async () => {
    const readBinary = jest.fn(async () => ({
      bytes: Uint8Array.from([1]),
      mediaType: "image/webp",
    }))
    const loader = createSessionMediaLoader("session-visible", { readBinary })

    const row = await loader!({ hash: HASH, variant: "thumbnail" })

    expect(readBinary).toHaveBeenCalledWith(expect.objectContaining({ variant: "thumbnail" }))
    expect(row).toMatchObject({ canonicalAvailable: false, byteSize: 1 })
    expect(row?.thumbBlob).toBeDefined()
  })

  it("provides the loader only to the wrapped transcript subtree", () => {
    const readBinary = jest.fn()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SessionMediaProvider sessionId="session-1" transport={{ readBinary }}>
        {children}
      </SessionMediaProvider>
    )

    const { result } = renderHook(() => useSessionMediaLoader(), { wrapper })

    expect(result.current).toEqual(expect.any(Function))
  })
})
