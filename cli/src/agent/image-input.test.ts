/**
 * @jest-environment node
 */
import { buildSendContent, extractImageRefs } from "./image-input"
import type { SendContentBlock } from "@cognia/agent-config-types"

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])

describe("extractImageRefs", () => {
  it("finds @-prefixed image paths and ignores non-image refs", () => {
    expect(extractImageRefs("look at @shot.png and @notes.txt then @a/b.JPG")).toEqual([
      "shot.png",
      "a/b.JPG",
    ])
  })

  it("strips trailing sentence punctuation but keeps the extension", () => {
    expect(extractImageRefs("see @diagram.png.")).toEqual(["diagram.png"])
  })

  it("returns nothing when there are no image refs", () => {
    expect(extractImageRefs("just text, no @images here")).toEqual([])
  })
})

describe("buildSendContent", () => {
  it("returns the plain string when no images are referenced", () => {
    const out = buildSendContent("hello world", "/work")
    expect(out).toEqual({ content: "hello world", imageCount: 0, failed: [] })
  })

  it("encodes a referenced image as a base64 content block alongside the text", () => {
    const out = buildSendContent("describe @shot.png please", "/work", {
      isFile: () => true,
      readFile: () => PNG,
    })
    expect(out.imageCount).toBe(1)
    const blocks = out.content as SendContentBlock[]
    expect(blocks[0]).toEqual({ type: "text", text: "describe @shot.png please" })
    expect(blocks[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") },
    })
  })

  it("maps extensions to media types (jpg→jpeg, webp, gif)", () => {
    const probe = (name: string) =>
      (
        buildSendContent(`@${name}`, "/w", { isFile: () => true, readFile: () => PNG })
          .content as SendContentBlock[]
      )[1]
    expect((probe("a.jpg") as { source: { media_type: string } }).source.media_type).toBe(
      "image/jpeg"
    )
    expect((probe("a.webp") as { source: { media_type: string } }).source.media_type).toBe(
      "image/webp"
    )
    expect((probe("a.gif") as { source: { media_type: string } }).source.media_type).toBe(
      "image/gif"
    )
  })

  it("notes an unreadable image inline and keeps the turn as plain text", () => {
    const out = buildSendContent("see @missing.png", "/work", {
      isFile: () => false,
      readFile: () => {
        throw new Error("ENOENT")
      },
    })
    expect(out.imageCount).toBe(0)
    expect(out.failed).toEqual(["missing.png"])
    // No readable image → plain string (unchanged wire shape).
    expect(out.content).toBe("see @missing.png")
  })

  it("appends a note when SOME images load and others fail", () => {
    const out = buildSendContent("@ok.png and @bad.png", "/work", {
      isFile: (p: string) => p.replace(/\\/g, "/").endsWith("ok.png"),
      readFile: (p: string) => {
        if (p.replace(/\\/g, "/").endsWith("ok.png")) return PNG
        throw new Error("ENOENT")
      },
    })
    expect(out.imageCount).toBe(1)
    expect(out.failed).toEqual(["bad.png"])
    const blocks = out.content as SendContentBlock[]
    expect((blocks[0] as { text: string }).text).toContain("[could not read image: bad.png]")
  })
})
