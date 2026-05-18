import {
  isTextSegment,
  isImageSegment,
  isA2UISegment,
  segmentsToPlainText,
  type MessageSegment,
  type A2UIMessageSegment,
} from "./segment"

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

  describe("a2ui segment", () => {
    const sample: A2UIMessageSegment = {
      type: "a2ui",
      surfaceId: "s-1",
      content: {
        components: {
          root: { id: "root", component: "Column", children: ["t1"] },
          t1: { id: "t1", component: "Text", text: "Hello world" },
        },
        dataModel: {},
        rootId: "root",
      },
      plainTextMirror: "Hello world",
    }

    it("isA2UISegment narrows", () => {
      const m: MessageSegment = sample
      expect(isA2UISegment(m)).toBe(true)
      expect(isA2UISegment({ type: "text", text: "x" })).toBe(false)
    })

    it("flattens via plainTextMirror", () => {
      expect(segmentsToPlainText([sample])).toBe(" Hello world ")
    })

    it("falls back to literal [a2ui] when plainTextMirror is empty", () => {
      const empty: A2UIMessageSegment = { ...sample, plainTextMirror: "" }
      expect(segmentsToPlainText([empty])).toBe(" [a2ui] ")
    })

    it("intermixes with other segments cleanly", () => {
      const out = segmentsToPlainText([
        { type: "text", text: "prefix" },
        sample,
        { type: "text", text: "suffix" },
      ])
      expect(out).toBe("prefix Hello world suffix")
    })
  })
})
