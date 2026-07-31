import {
  MAX_SPRITE_V2_ATLAS_BYTES,
  SPRITE_V2_ATLAS_HEIGHT,
  SPRITE_V2_ATLAS_WIDTH,
  validateSpriteV2Import,
} from "./import"

const validManifest = {
  id: "momo-v2",
  displayName: "Momo",
  description: "A cheerful pet.",
  spriteVersionNumber: 2,
  spritesheetPath: "spritesheet.webp",
}

function webp(): Blob {
  return new Blob(["sprite-bytes"], { type: "image/webp" })
}

const readValidDimensions = jest.fn(async () => ({
  width: SPRITE_V2_ATLAS_WIDTH,
  height: SPRITE_V2_ATLAS_HEIGHT,
}))

describe("validateSpriteV2Import", () => {
  beforeEach(() => {
    readValidDimensions.mockClear()
  })

  it("returns a normalized install payload for a valid v2 pack", async () => {
    const spritesheet = webp()

    await expect(
      validateSpriteV2Import({
        manifest: validManifest,
        spritesheet,
        readImageDimensions: readValidDimensions,
      })
    ).resolves.toEqual({
      id: "momo-v2",
      displayName: "Momo",
      description: "A cheerful pet.",
      spriteVersionNumber: 2,
      spritesheet,
    })
    expect(readValidDimensions).toHaveBeenCalledWith(spritesheet)
  })

  it.each([
    ["missing manifest", undefined, "manifest must be an object"],
    ["invalid id", { ...validManifest, id: "../Momo" }, "manifest.id"],
    ["blank display name", { ...validManifest, displayName: "  " }, "manifest.displayName"],
    ["missing description", { ...validManifest, description: undefined }, "manifest.description"],
    ["wrong version", { ...validManifest, spriteVersionNumber: 1 }, "spriteVersionNumber"],
    [
      "unsafe path",
      { ...validManifest, spritesheetPath: "../spritesheet.webp" },
      "spritesheetPath",
    ],
    [
      "wrong extension",
      { ...validManifest, spritesheetPath: "spritesheet.gif" },
      "spritesheetPath",
    ],
  ])("rejects %s", async (_label, manifest, expectedMessage) => {
    await expect(
      validateSpriteV2Import({
        manifest,
        spritesheet: webp(),
        readImageDimensions: readValidDimensions,
      })
    ).rejects.toThrow(expectedMessage)
    expect(readValidDimensions).not.toHaveBeenCalled()
  })

  it.each(["", "image/gif", "application/octet-stream"])(
    "rejects an unsupported spritesheet MIME type %p",
    async (type) => {
      await expect(
        validateSpriteV2Import({
          manifest: validManifest,
          spritesheet: new Blob(["sprite"], { type }),
          readImageDimensions: readValidDimensions,
        })
      ).rejects.toThrow("spritesheet MIME type")
      expect(readValidDimensions).not.toHaveBeenCalled()
    }
  )

  it("requires the manifest extension to agree with the MIME type", async () => {
    await expect(
      validateSpriteV2Import({
        manifest: { ...validManifest, spritesheetPath: "spritesheet.png" },
        spritesheet: webp(),
        readImageDimensions: readValidDimensions,
      })
    ).rejects.toThrow("does not match")
  })

  it("rejects an empty spritesheet", async () => {
    await expect(
      validateSpriteV2Import({
        manifest: validManifest,
        spritesheet: new Blob([], { type: "image/webp" }),
        readImageDimensions: readValidDimensions,
      })
    ).rejects.toThrow("must not be empty")
    expect(readValidDimensions).not.toHaveBeenCalled()
  })

  it("rejects a spritesheet larger than 25 MiB before decoding", async () => {
    const spritesheet = webp()
    Object.defineProperty(spritesheet, "size", { value: MAX_SPRITE_V2_ATLAS_BYTES + 1 })

    await expect(
      validateSpriteV2Import({
        manifest: validManifest,
        spritesheet,
        readImageDimensions: readValidDimensions,
      })
    ).rejects.toThrow("exceeds the 25 MiB limit")
    expect(readValidDimensions).not.toHaveBeenCalled()
  })

  it("rejects an id already installed", async () => {
    await expect(
      validateSpriteV2Import({
        manifest: validManifest,
        spritesheet: webp(),
        existingIds: new Set(["other", "momo-v2"]),
        readImageDimensions: readValidDimensions,
      })
    ).rejects.toThrow("already installed")
    expect(readValidDimensions).not.toHaveBeenCalled()
  })

  it.each([
    [{ width: 1535, height: 2288 }, "1535x2288"],
    [{ width: 1536, height: 2287 }, "1536x2287"],
    [{ width: Number.NaN, height: 2288 }, "invalid dimensions"],
  ])("rejects invalid atlas dimensions %#", async (dimensions, expectedMessage) => {
    await expect(
      validateSpriteV2Import({
        manifest: validManifest,
        spritesheet: webp(),
        readImageDimensions: async () => dimensions,
      })
    ).rejects.toThrow(expectedMessage)
  })

  it("wraps image decoding failures with import context", async () => {
    await expect(
      validateSpriteV2Import({
        manifest: validManifest,
        spritesheet: webp(),
        readImageDimensions: async () => {
          throw new Error("decoder failed")
        },
      })
    ).rejects.toThrow("Unable to read spritesheet dimensions: decoder failed")
  })

  it("tags each failure with a typed code the UI can translate", async () => {
    await expect(
      validateSpriteV2Import({
        manifest: undefined,
        spritesheet: webp(),
        readImageDimensions: readValidDimensions,
      })
    ).rejects.toMatchObject({ code: "bad-manifest" })

    await expect(
      validateSpriteV2Import({
        manifest: validManifest,
        spritesheet: new Blob(["x"], { type: "image/gif" }),
        readImageDimensions: readValidDimensions,
      })
    ).rejects.toMatchObject({ code: "bad-format" })

    await expect(
      validateSpriteV2Import({
        manifest: validManifest,
        spritesheet: webp(),
        existingIds: new Set(["momo-v2"]),
        readImageDimensions: readValidDimensions,
      })
    ).rejects.toMatchObject({ code: "already-installed" })

    await expect(
      validateSpriteV2Import({
        manifest: validManifest,
        spritesheet: webp(),
        readImageDimensions: async () => ({ width: 10, height: 10 }),
      })
    ).rejects.toMatchObject({ code: "bad-dimensions" })

    const bigSheet = webp()
    Object.defineProperty(bigSheet, "size", { value: MAX_SPRITE_V2_ATLAS_BYTES + 1 })
    await expect(
      validateSpriteV2Import({
        manifest: validManifest,
        spritesheet: bigSheet,
        readImageDimensions: readValidDimensions,
      })
    ).rejects.toMatchObject({ code: "too-large" })
  })
})
