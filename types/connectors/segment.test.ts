import { isTextSegment, isImageSegment, segmentsToPlainText, type MessageSegment } from "./segment"

describe("MessageSegment", () => {
  it("type guards narrow correctly", () => {
    const t: MessageSegment = { type: "text", text: "hi" }
    const i: MessageSegment = { type: "image", url: "http://x/y.png" }
    expect(isTextSegment(t)).toBe(true)
    expect(isTextSegment(i)).toBe(false)
    expect(isImageSegment(i)).toBe(true)
  })

  it("flattens segments to plain text for trigger matchers", () => {
    const segs: MessageSegment[] = [
      { type: "text", text: "hello " },
      { type: "mention", userId: "u1", displayName: "Alice" },
      { type: "text", text: ", check this:" },
      { type: "image", url: "http://x/y.png" },
      { type: "code", language: "ts", code: "const x = 1" },
    ]
    expect(segmentsToPlainText(segs)).toBe("hello @Alice, check this: [image] const x = 1")
  })
})
