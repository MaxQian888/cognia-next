jest.mock("@/lib/files/workspace-fs", () => ({ readWorkspaceFileChunk: jest.fn() }))

import { readWorkspaceFileChunk } from "@/lib/files/workspace-fs"

import { ShareFileChangedError } from "./blobs"
import {
  blobShareSource,
  bytesShareSource,
  textShareSource,
  workspaceShareSource,
} from "./file-sources"

const readChunk = readWorkspaceFileChunk as jest.Mock

beforeEach(() => readChunk.mockReset())

describe("in-memory sources", () => {
  it("slices bytes and text", async () => {
    const bytes = bytesShareSource(new Uint8Array([1, 2, 3, 4, 5]))
    expect(bytes.size).toBe(5)
    expect(Array.from(await bytes.read(1, 3))).toEqual([2, 3, 4])

    const text = textShareSource("héllo")
    expect(text.size).toBe(6)
    expect(new TextDecoder().decode(await text.read(0, 6))).toBe("héllo")
  })

  it("slices a Blob", async () => {
    const source = blobShareSource(new Blob([new Uint8Array([9, 8, 7, 6])]))
    expect(source.size).toBe(4)
    expect(Array.from(await source.read(2, 2))).toEqual([7, 6])
  })

  it("refuses to read after an abort", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(textShareSource("x").read(0, 1, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    })
  })
})

describe("workspaceShareSource", () => {
  it("reads one chunk through the host and decodes it", async () => {
    readChunk.mockResolvedValue({ dataBase64: "AQID", offset: 4, bytesRead: 3, size: 7, eof: true })
    const source = workspaceShareSource("/repo", "a.bin", 7, "/workspace/a.bin")
    expect(Array.from(await source.read(4, 3))).toEqual([1, 2, 3])
    expect(readChunk).toHaveBeenCalledWith("/repo", "a.bin", 4, 3)
  })

  it("refuses a file whose size moved or that came back short", async () => {
    const source = workspaceShareSource("/repo", "a.bin", 7, "/workspace/a.bin")
    readChunk.mockResolvedValueOnce({
      dataBase64: "AQID",
      offset: 0,
      bytesRead: 3,
      size: 9,
      eof: false,
    })
    await expect(source.read(0, 3)).rejects.toBeInstanceOf(ShareFileChangedError)
    readChunk.mockResolvedValueOnce({
      dataBase64: "AQ==",
      offset: 4,
      bytesRead: 1,
      size: 7,
      eof: true,
    })
    await expect(source.read(4, 3)).rejects.toBeInstanceOf(ShareFileChangedError)
  })
})
