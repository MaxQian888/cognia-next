import type { SendContentBlock } from "@cognia/agent-config-types"
import {
  prepareExternalTurnImages,
  withheldTurnImages,
  type ExternalTurnImage,
  type PreparedTurnImages,
} from "./turn-images"

const toPortableImage = jest.fn()
jest.mock("@/lib/ocr/image-prep", () => {
  const actual = jest.requireActual("@/lib/ocr/image-prep")
  return {
    ...actual,
    toPortableImage: (...args: unknown[]) => toPortableImage(...args),
  }
})

const block = (mediaType: string, data: string): Extract<SendContentBlock, { type: "image" }> => ({
  type: "image",
  source: { type: "base64", media_type: mediaType, data },
})

beforeEach(() => {
  toPortableImage.mockReset()
  toPortableImage.mockImplementation(async (bytes: Uint8Array, mimeType: string) =>
    mimeType === "image/jpg" ? { bytes, mimeType: "image/jpeg" } : { bytes, mimeType }
  )
})

describe("prepareExternalTurnImages", () => {
  it("keeps a portable image's bytes as they are, with its attachment", async () => {
    const images: ExternalTurnImage[] = [
      { block: block("image/png", "iVBORw0KGgo="), attachment: 0 },
      { block: block("image/jpg", "/9j/4AAQ"), attachment: null },
    ]
    expect(await prepareExternalTurnImages(images)).toEqual({
      ready: [
        {
          content: {
            type: "image",
            source: { type: "base64", data: "iVBORw0KGgo=", mediaType: "image/png" },
          },
          attachment: 0,
        },
        {
          content: {
            type: "image",
            source: { type: "base64", data: "/9j/4AAQ", mediaType: "image/jpeg" },
          },
          attachment: null,
        },
      ],
      unreadable: [],
    })
  })

  it("re-encodes a format agents refuse, decoding its bytes first", async () => {
    toPortableImage.mockImplementation(async (bytes: Uint8Array) => {
      expect(Array.from(bytes)).toEqual([1, 2, 3])
      return { bytes: new Uint8Array([4, 5, 6]), mimeType: "image/png" }
    })
    const result = await prepareExternalTurnImages([
      { block: block("image/bmp", "AQID"), attachment: 2 },
    ])
    expect(result.ready).toEqual([
      {
        content: {
          type: "image",
          source: { type: "base64", data: "BAUG", mediaType: "image/png" },
        },
        attachment: 2,
      },
    ])
    expect(result.unreadable).toEqual([])
  })

  it("reports an image this runtime cannot convert instead of sending it", async () => {
    toPortableImage.mockResolvedValue(null)
    const heic = { block: block("image/heic", "AQID"), attachment: 1 }
    expect(await prepareExternalTurnImages([heic])).toEqual({ ready: [], unreadable: [heic] })
  })
})

describe("withheldTurnImages", () => {
  const image = (attachment: number | null) => ({
    content: {
      type: "image" as const,
      source: { type: "base64" as const, data: "x", mediaType: "image/png" },
    },
    attachment,
  })
  const prepared: PreparedTurnImages = {
    ready: [image(0), image(null)],
    unreadable: [{ block: block("image/heic", "x"), attachment: 3 }],
  }

  it("names the unconvertible images and everything a verdict held back", () => {
    expect(
      withheldTurnImages(prepared, { reason: "model", count: 2, model: "DeepSeek V4 Pro" })
    ).toEqual([
      { reason: "format", attachments: [3] },
      { reason: "model", attachments: [0, null], model: "DeepSeek V4 Pro" },
    ])
    expect(withheldTurnImages(prepared, { reason: "host" })).toEqual([
      { reason: "format", attachments: [3] },
      { reason: "host", attachments: [0, null] },
    ])
  })

  it("is empty when every image went", () => {
    expect(withheldTurnImages({ ready: [image(0)], unreadable: [] }, null)).toEqual([])
    expect(
      withheldTurnImages({ ready: [], unreadable: [] }, { reason: "agent", count: 0 })
    ).toEqual([])
  })
})
