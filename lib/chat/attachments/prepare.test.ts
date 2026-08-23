import {
  ATTACHMENT_UPLOAD_CHUNK_BYTES,
  COMPOSER_MAX_ATTACHMENTS,
  COMPOSER_MAX_ATTACHMENT_BYTES,
  isSupportedAttachmentDescriptor,
  isSupportedComposerAttachment,
  prepareComposerAttachments,
} from "./prepare"

function sizedFile(name: string, type: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type })
}

describe("prepareComposerAttachments", () => {
  it("accepts supported documents and reports unsupported inputs", async () => {
    const result = await prepareComposerAttachments(
      [sizedFile("notes.log", "text/plain", 10), sizedFile("archive.zip", "application/zip", 10)],
      { maxFileSize: 100 }
    )
    expect(result.files.map((file) => file.name)).toEqual(["notes.log"])
    expect(result.unsupportedCount).toBe(1)
    expect(result.tooLargeCount).toBe(0)
  })

  it("does not optimize supported files already below the limit", async () => {
    const optimizeImage = jest.fn()
    const image = sizedFile("small.png", "image/png", 20)
    const result = await prepareComposerAttachments([image], {
      maxFileSize: 100,
      optimizeImage,
    })

    expect(result.files).toEqual([image])
    expect(optimizeImage).not.toHaveBeenCalled()
    expect(result.optimizedCount).toBe(0)
  })

  it("rescues an oversized image when downsampling brings it under the limit", async () => {
    const original = sizedFile("camera.jpg", "image/jpeg", 200)
    const optimized = sizedFile("camera.jpg", "image/jpeg", 80)
    const optimizeImage = jest.fn(async () => optimized)

    const result = await prepareComposerAttachments([original], {
      maxFileSize: 100,
      optimizeImage,
    })

    expect(optimizeImage).toHaveBeenCalledWith(original)
    expect(result.files).toEqual([optimized])
    expect(result.optimizedCount).toBe(1)
    expect(result.tooLargeCount).toBe(0)
  })

  it("rejects an oversized document or an image that cannot be reduced enough", async () => {
    const document = sizedFile("large.pdf", "application/pdf", 200)
    const image = sizedFile("large.png", "image/png", 200)
    const result = await prepareComposerAttachments([document, image], {
      maxFileSize: 100,
      optimizeImage: async (file) => file,
    })

    expect(result.files).toEqual([])
    expect(result.tooLargeCount).toBe(2)
    expect(result.optimizedCount).toBe(0)
  })

  it("treats image optimization failures as a normal size rejection", async () => {
    const result = await prepareComposerAttachments([sizedFile("broken.png", "image/png", 200)], {
      maxFileSize: 100,
      optimizeImage: async () => {
        throw new Error("decoder unavailable")
      },
    })
    expect(result.files).toEqual([])
    expect(result.tooLargeCount).toBe(1)
  })

  it("preserves animated GIFs instead of flattening them during oversized-image rescue", async () => {
    const result = await prepareComposerAttachments([sizedFile("animated.gif", "image/gif", 200)], {
      maxFileSize: 100,
    })

    expect(result.files).toEqual([])
    expect(result.optimizedCount).toBe(0)
    expect(result.tooLargeCount).toBe(1)
  })

  it("falls back to normal size rejection when the runtime cannot downsample an oversized image", async () => {
    const result = await prepareComposerAttachments(
      [sizedFile("oversized.png", "image/png", 200)],
      { maxFileSize: 100 }
    )

    expect(result.files).toEqual([])
    expect(result.optimizedCount).toBe(0)
    expect(result.tooLargeCount).toBe(1)
  })
})

describe("isSupportedAttachmentDescriptor", () => {
  it("accepts anything the paperclip would, from metadata alone", () => {
    // The Host validates an upload it has not received yet, so the rule has to
    // hold over `{name, mediaType}` and not over a `File`.
    expect(isSupportedAttachmentDescriptor({ name: "shot.png", mediaType: "image/png" })).toBe(true)
    expect(isSupportedAttachmentDescriptor({ name: "notes.pdf", mediaType: "" })).toBe(true)
    expect(isSupportedAttachmentDescriptor({ name: "run.sh", mediaType: "" })).toBe(true)
    expect(
      isSupportedAttachmentDescriptor({ name: "app.dmg", mediaType: "application/octet-stream" })
    ).toBe(false)
  })

  it("is the same rule the composer applies to a File", () => {
    const cases = [
      new File([new Uint8Array(1)], "shot.png", { type: "image/png" }),
      new File([new Uint8Array(1)], "app.dmg", { type: "application/octet-stream" }),
      new File([new Uint8Array(1)], "notes.md", { type: "" }),
    ]
    for (const file of cases) {
      expect(isSupportedComposerAttachment(file)).toBe(
        isSupportedAttachmentDescriptor({ name: file.name, mediaType: file.type })
      )
    }
  })
})

describe("shared attachment ceilings", () => {
  it("keeps a base64 chunk inside the RPC body ceiling", () => {
    // 4/3 inflation plus the JSON envelope; the ceiling is 64 KB.
    expect(Math.ceil(ATTACHMENT_UPLOAD_CHUNK_BYTES / 3) * 4).toBeLessThan(64 * 1024)
  })

  it("states the composer limits once so the Host can publish them", () => {
    expect(COMPOSER_MAX_ATTACHMENTS).toBe(6)
    expect(COMPOSER_MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024)
  })
})
