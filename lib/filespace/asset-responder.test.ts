import {
  answerFileSpaceAsset,
  MAX_FILESPACE_ASSET_SLICE,
  readFileSpaceAssetSlice,
  type FileSpaceAssetRequest,
  type FileSpaceAssetSources,
} from "./asset-responder"

function request(patch: Partial<FileSpaceAssetRequest> = {}): FileSpaceAssetRequest {
  return {
    requestId: "rid",
    kind: "filespace_asset",
    sessionId: "s1",
    mountId: "uploads",
    sourceId: "asset-1",
    offset: 0,
    length: 4,
    ...patch,
  }
}

function blob(bytes: number[], type = "image/png"): Blob {
  const data = Uint8Array.from(bytes)
  return {
    size: data.byteLength,
    type,
    slice: (start: number, end: number) =>
      ({
        arrayBuffer: async () => data.slice(start, end).buffer,
      }) as unknown as Blob,
  } as unknown as Blob
}

function sources(patch: Partial<FileSpaceAssetSources> = {}): FileSpaceAssetSources {
  return {
    readUpload: jest.fn(async (sessionId: string, assetId: string) =>
      sessionId === "s1" && assetId === "asset-1" ? blob([1, 2, 3, 4, 5, 6]) : null
    ),
    readArtifact: jest.fn(async (sessionId: string, artifactId: string) =>
      sessionId === "s1" && artifactId === "art-1" ? "héllo" : null
    ),
    ...patch,
  }
}

describe("readFileSpaceAssetSlice", () => {
  it("reads one slice of an upload and stops at the end", async () => {
    await expect(
      readFileSpaceAssetSlice(request({ offset: 2, length: 3 }), sources())
    ).resolves.toEqual({ bytes: Uint8Array.from([3, 4, 5]), mediaType: "image/png" })
    await expect(
      readFileSpaceAssetSlice(request({ offset: 4, length: 100 }), sources())
    ).resolves.toEqual({ bytes: Uint8Array.from([5, 6]), mediaType: "image/png" })
    // Past the end is an empty slice, which the host reads as end of file.
    await expect(
      readFileSpaceAssetSlice(request({ offset: 99, length: 4 }), sources())
    ).resolves.toEqual({ bytes: new Uint8Array(), mediaType: "image/png" })
  })

  it("reads an artifact's source as UTF-8 bytes", async () => {
    const encoded = new TextEncoder().encode("héllo")
    await expect(
      readFileSpaceAssetSlice(
        request({ mountId: "artifacts", sourceId: "art-1", offset: 1, length: 2 }),
        sources()
      )
    ).resolves.toEqual({ bytes: encoded.slice(1, 3), mediaType: "application/octet-stream" })
  })

  it("asks only for the session the host named, and caps the slice", async () => {
    const src = sources()
    await readFileSpaceAssetSlice(
      request({ sessionId: "s2", length: MAX_FILESPACE_ASSET_SLICE * 4 }),
      src
    )
    expect(src.readUpload).toHaveBeenCalledWith("s2", "asset-1")
    await expect(readFileSpaceAssetSlice(request({ sessionId: "s2" }), src)).resolves.toEqual({
      error: "MEDIA_NOT_FOUND",
    })
    await expect(
      readFileSpaceAssetSlice(request({ mountId: "artifacts", sourceId: "other" }), src)
    ).resolves.toEqual({ error: "MEDIA_NOT_FOUND" })
  })

  it("refuses malformed requests before reading anything", async () => {
    const src = sources()
    for (const bad of [
      request({ mountId: "workspace" }),
      request({ offset: -1 }),
      request({ length: 1.5 }),
      request({ sourceId: "" }),
      request({ sessionId: "" }),
    ]) {
      await expect(readFileSpaceAssetSlice(bad, src)).resolves.toEqual({ error: "INVALID_PARAMS" })
    }
    expect(src.readUpload).not.toHaveBeenCalled()
  })
})

describe("answerFileSpaceAsset", () => {
  it("answers bytes, a named refusal, or a refusal for a failed read", async () => {
    const respondMedia = jest.fn(async () => undefined)
    await answerFileSpaceAsset(request({ length: 2 }), { respondMedia }, sources())
    expect(respondMedia).toHaveBeenLastCalledWith({
      requestId: "rid",
      bytes: Uint8Array.from([1, 2]),
      mediaType: "image/png",
    })
    await answerFileSpaceAsset(request({ sourceId: "missing" }), { respondMedia }, sources())
    expect(respondMedia).toHaveBeenLastCalledWith({
      requestId: "rid",
      bytes: new Uint8Array(),
      mediaType: "application/octet-stream",
      error: "MEDIA_NOT_FOUND",
    })
    await answerFileSpaceAsset(
      request(),
      { respondMedia },
      sources({
        readUpload: async () => {
          throw new Error("idb closed")
        },
      })
    )
    expect(respondMedia).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: "rid", error: "MEDIA_NOT_FOUND" })
    )
  })

  it("cannot answer a request with no id", async () => {
    const respondMedia = jest.fn(async () => undefined)
    await answerFileSpaceAsset(request({ requestId: "" }), { respondMedia }, sources())
    expect(respondMedia).not.toHaveBeenCalled()
  })
})
