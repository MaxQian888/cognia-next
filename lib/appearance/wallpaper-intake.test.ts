/**
 * @jest-environment jsdom
 */
import {
  ACCEPTED_WALLPAPER_MIMES,
  intakeWallpaperFile,
  isAcceptedWallpaperType,
} from "./wallpaper-intake"
import { MAX_WALLPAPER_BYTES } from "./wallpaper-storage"

jest.mock("./image-utils", () => ({
  readImageDimensions: jest.fn(async () => ({ width: 800, height: 600 })),
}))
import { readImageDimensions } from "./image-utils"

function makeFile(name: string, type: string, size: number): File {
  const file = new File(["x"], name, { type })
  Object.defineProperty(file, "size", { value: size })
  file.arrayBuffer = jest.fn(async () => new ArrayBuffer(size))
  return file
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("isAcceptedWallpaperType", () => {
  it.each(ACCEPTED_WALLPAPER_MIMES)("accepts %s", (mime) => {
    expect(isAcceptedWallpaperType(mime)).toBe(true)
  })

  it.each(["image/bmp", "application/pdf", "text/plain", ""])("rejects %s", (mime) => {
    expect(isAcceptedWallpaperType(mime)).toBe(false)
  })
})

describe("intakeWallpaperFile", () => {
  it("reads an accepted file into bytes plus dimensions", async () => {
    const result = await intakeWallpaperFile(makeFile("shot.png", "image/png", 1024))
    expect(result).toEqual({
      ok: true,
      file: {
        bytes: expect.any(ArrayBuffer),
        mime: "image/png",
        width: 800,
        height: 600,
        fileName: "shot.png",
      },
    })
  })

  it("rejects an unsupported type", async () => {
    const result = await intakeWallpaperFile(makeFile("doc.pdf", "application/pdf", 10))
    expect(result).toEqual({ ok: false, reason: "invalidType" })
  })

  it("rejects a file over the size cap", async () => {
    const file = makeFile("huge.png", "image/png", MAX_WALLPAPER_BYTES + 1)
    expect(await intakeWallpaperFile(file)).toEqual({ ok: false, reason: "tooLarge" })
  })

  it("accepts a file exactly at the cap", async () => {
    const file = makeFile("edge.png", "image/png", MAX_WALLPAPER_BYTES)
    expect((await intakeWallpaperFile(file)).ok).toBe(true)
  })

  // Reading an oversized file into memory just to reject it is the bug this
  // ordering exists to prevent.
  it("rejects before touching the bytes", async () => {
    const file = makeFile("huge.png", "image/png", MAX_WALLPAPER_BYTES + 1)
    await intakeWallpaperFile(file)
    expect(file.arrayBuffer).not.toHaveBeenCalled()
    expect(readImageDimensions).not.toHaveBeenCalled()
  })
})
