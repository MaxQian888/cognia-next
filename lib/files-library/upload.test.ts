const ingestImageMock = jest.fn()
jest.mock("@/lib/chat/media/ingest-media", () => ({
  MAX_IMAGE_INPUT_BYTES: 10 * 1024 * 1024,
  ingestImage: (...args: unknown[]) => ingestImageMock(...args),
}))
const extractAttachmentMock = jest.fn()
jest.mock("@/lib/chat/attachments/dispatch", () => ({
  extractAttachment: (...args: unknown[]) => extractAttachmentMock(...args),
}))

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { hashSessionAssetSource, listLibraryAssets } from "@/lib/db/session-assets"
import { loggers } from "@cognia/logging"
import { FILES_EXTRACT_MAX_BYTES, isIngestibleImage, uploadFileToLibrary } from "./upload"

jest.setTimeout(30_000)
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  ingestImageMock.mockReset()
  extractAttachmentMock.mockReset()
})
afterAll(fixture.dispose)

describe("isIngestibleImage", () => {
  it("takes raster images within the chat limit and leaves SVG and huge images as files", () => {
    expect(isIngestibleImage({ type: "image/png", size: 10 })).toBe(true)
    expect(isIngestibleImage({ type: "image/svg+xml", size: 10 })).toBe(false)
    expect(isIngestibleImage({ type: "image/png", size: 11 * 1024 * 1024 })).toBe(false)
    expect(isIngestibleImage({ type: "text/plain", size: 10 })).toBe(false)
  })
})

describe("uploadFileToLibrary", () => {
  it("ingests an image and adopts it as Files-owned", async () => {
    ingestImageMock.mockImplementation(async () => {
      await getDb().messageMedia.put({
        hash: "imghash",
        mediaType: "image/webp",
        width: 1,
        height: 1,
        blob: new Blob(["x"]),
        byteSize: 1,
        createdAt: 1,
        lastUsedAt: 1,
      })
      return {
        ref: "cognia-media:imghash",
        mediaType: "image/webp",
        width: 1,
        height: 1,
        byteSize: 1,
      }
    })
    const file = new File(["png-bytes"], "shot.png", { type: "image/png" })
    await expect(uploadFileToLibrary(file, { projectId: "p1" })).resolves.toEqual({
      key: "image:imghash",
      kind: "image",
      extracted: false,
    })
    expect(ingestImageMock).toHaveBeenCalledWith(
      expect.objectContaining({ mediaType: "image/png", keepOriginal: true })
    )
    expect(await getDb().libraryItems.get("image:imghash")).toMatchObject({
      ownedByFiles: true,
      projectId: "p1",
      mediaHash: "imghash",
      snapshot: { title: "shot.png", mediaType: "image/webp", byteSize: 1 },
    })
    expect(await getDb().messageMediaRefs.where("hash").equals("imghash").count()).toBe(1)
  })

  it("stores a document with its extracted text", async () => {
    const file = new File(["# Design"], "DESIGN.md", { type: "text/markdown" })
    const contentHash = await hashSessionAssetSource(file)
    extractAttachmentMock.mockImplementation(async (submitted: { id: string; url: string }) => {
      expect(submitted.url.startsWith("data:text/markdown;base64,")).toBe(true)
      return {
        kind: "document",
        block: { type: "text", text: "# Design" },
        tokens: 2,
        extractedContent: {
          attachmentId: submitted.id,
          contentHash,
          status: "ready",
          processor: { id: "cognia-attachment", version: "2" },
          segments: [{ id: "s1", text: "# Design", locator: { type: "page", page: 1 } }],
        },
      }
    })
    const result = await uploadFileToLibrary(file)
    expect(result).toMatchObject({ kind: "upload", extracted: true })
    const [asset] = await listLibraryAssets()
    expect(asset).toMatchObject({ filename: "DESIGN.md", mediaType: "text/markdown" })
    expect(asset!.extractedContent?.segments[0]?.text).toBe("# Design")
    expect(result.key).toBe(`upload:${asset!.assetId}`)
  })

  it("keeps the file when extraction fails or yields nothing", async () => {
    const warn = jest.spyOn(loggers.store, "warn").mockImplementation(() => {})
    extractAttachmentMock.mockRejectedValueOnce(new Error("parser crashed"))
    await expect(
      uploadFileToLibrary(new File(["a"], "a.docx", { type: "application/octet-stream" }))
    ).resolves.toMatchObject({ extracted: false })
    expect(warn).toHaveBeenCalledWith("files upload extraction failed", {
      error: "Error: parser crashed",
    })
    warn.mockRestore()
    extractAttachmentMock.mockResolvedValueOnce({ kind: "document", block: null, tokens: 0 })
    await expect(uploadFileToLibrary(new File(["b"], "b.bin"))).resolves.toMatchObject({
      extracted: false,
    })
    expect(await listLibraryAssets()).toHaveLength(2)
    expect((await listLibraryAssets()).map((a) => a.mediaType)).toContain(
      "application/octet-stream"
    )
  })

  it("skips extraction above the size ceiling", async () => {
    const big = new File(["x"], "big.pdf", { type: "application/pdf" })
    Object.defineProperty(big, "size", { value: FILES_EXTRACT_MAX_BYTES + 1 })
    await expect(
      uploadFileToLibrary(big).catch((error: Error) => error.message)
    ).resolves.toBeDefined()
    expect(extractAttachmentMock).not.toHaveBeenCalled()
  })
})
