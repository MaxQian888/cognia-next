import {
  ATTACHMENT_UPLOAD_CHUNK_BYTES,
  COMPOSER_MAX_ATTACHMENTS,
  COMPOSER_MAX_ATTACHMENT_BYTES,
  COMPOSER_VIDEO_SOURCE_MAX_BYTES,
  isSupportedAttachmentDescriptor,
  isSupportedComposerAttachment,
  prepareComposerAttachments,
} from "./prepare"

function sizedFile(name: string, type: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type })
}

/**
 * A valid 1×1 GIF with `frames` frames, padded past `padTo` bytes with a
 * comment extension so size limits can be exercised on real GIF bytes.
 */
function gifFile(name: string, frames: number, padTo = 0): File {
  const bytes: number[] = [..."GIF89a"].map((c) => c.charCodeAt(0))
  bytes.push(1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255)
  for (let i = 0; i < frames; i++) {
    bytes.push(0x21, 0xf9, 4, 0, 10, 0, 0, 0)
    // One pixel of colour `i % 2`: clear(2) · index · end(3), in 2-bit codes.
    bytes.push(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, (2 | ((i % 2) << 2) | (3 << 4)) & 0xff, 0)
  }
  while (bytes.length < padTo) {
    const chunk = Math.min(255, padTo - bytes.length)
    bytes.push(0x21, 0xfe, chunk, ...new Array(chunk).fill(0x20), 0)
  }
  bytes.push(0x3b)
  return new File([Uint8Array.from(bytes)], name, { type: "image/gif" })
}

const motion = { maxSourceBytes: 5_000 }

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
    const result = await prepareComposerAttachments([gifFile("animated.gif", 3, 400)], {
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

describe("prepareComposerAttachments — motion intake", () => {
  it("keeps videos unsupported unless the intake opts in", async () => {
    const clip = sizedFile("clip.mp4", "video/mp4", 50)
    const off = await prepareComposerAttachments([clip], { maxFileSize: 100 })
    expect(off.files).toEqual([])
    expect(off.unsupportedCount).toBe(1)

    const on = await prepareComposerAttachments([clip], { maxFileSize: 100, motion })
    expect(on.files).toEqual([clip])
    expect(on.unsupportedCount).toBe(0)
  })

  it("holds a video to the motion ceiling, not the attachment ceiling", async () => {
    const result = await prepareComposerAttachments(
      [
        sizedFile("long.mov", "video/quicktime", 4_000),
        sizedFile("huge.mov", "video/quicktime", 6_000),
      ],
      { maxFileSize: 100, motion }
    )
    expect(result.files.map((f) => f.name)).toEqual(["long.mov"])
    expect(result.motionTooLargeCount).toBe(1)
    expect(result.tooLargeCount).toBe(0)
  })

  it("gives a typeless video its media type from the extension", async () => {
    const result = await prepareComposerAttachments([sizedFile("screen.webm", "", 10)], {
      maxFileSize: 100,
      motion,
    })
    expect(result.files[0]!.type).toBe("video/webm")
    expect(result.files[0]!.size).toBe(10)
  })

  it("passes an oversized animated GIF to the motion pipeline", async () => {
    const optimizeImage = jest.fn()
    const result = await prepareComposerAttachments([gifFile("loop.gif", 4, 400)], {
      maxFileSize: 100,
      optimizeImage,
      motion,
    })
    expect(result.files.map((f) => f.name)).toEqual(["loop.gif"])
    expect(optimizeImage).not.toHaveBeenCalled()
  })

  it("rescues an oversized still GIF like any other image", async () => {
    const small = sizedFile("still.gif", "image/gif", 50)
    const optimizeImage = jest.fn(async () => small)
    const result = await prepareComposerAttachments([gifFile("still.gif", 1, 400)], {
      maxFileSize: 100,
      optimizeImage,
      motion,
    })
    expect(optimizeImage).toHaveBeenCalled()
    expect(result.files).toEqual([small])
    expect(result.optimizedCount).toBe(1)
  })

  it("refuses a GIF over the motion ceiling without reading it", async () => {
    const result = await prepareComposerAttachments([sizedFile("giant.gif", "image/gif", 6_000)], {
      maxFileSize: 100,
      motion,
    })
    expect(result.files).toEqual([])
    expect(result.motionTooLargeCount).toBe(1)
  })

  it("leaves images and documents on their usual path", async () => {
    const png = sizedFile("a.png", "image/png", 10)
    const pdf = sizedFile("a.pdf", "application/pdf", 10)
    const result = await prepareComposerAttachments([png, pdf], { maxFileSize: 100, motion })
    expect(result.files).toEqual([png, pdf])
  })
})

describe("isSupportedAttachmentDescriptor", () => {
  it("never accepts a video: the Host's upload gate shares this rule", () => {
    expect(isSupportedAttachmentDescriptor({ name: "clip.mp4", mediaType: "video/mp4" })).toBe(
      false
    )
  })

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
    expect(COMPOSER_VIDEO_SOURCE_MAX_BYTES).toBe(500 * 1024 * 1024)
  })
})
