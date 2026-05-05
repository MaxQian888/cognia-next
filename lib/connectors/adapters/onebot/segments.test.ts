import {
  fromOneBotSegments,
  toOneBotSegments,
  parseCqCodeString,
  type OneBotSegment,
} from "./segments"

// ---------------------------------------------------------------------------
// fromOneBotSegments (v11)
// ---------------------------------------------------------------------------

describe("fromOneBotSegments v11", () => {
  it("text segment", () => {
    const segs: OneBotSegment[] = [{ type: "text", data: { text: "hello" } }]
    expect(fromOneBotSegments(segs, "v11")).toEqual([{ type: "text", text: "hello" }])
  })

  it("image segment uses url field", () => {
    const segs: OneBotSegment[] = [{ type: "image", data: { url: "https://img.example/a.png" } }]
    expect(fromOneBotSegments(segs, "v11")).toEqual([
      { type: "image", url: "https://img.example/a.png" },
    ])
  })

  it("image segment falls back to file field", () => {
    const segs: OneBotSegment[] = [{ type: "image", data: { file: "file:///a.png" } }]
    expect(fromOneBotSegments(segs, "v11")).toEqual([{ type: "image", url: "file:///a.png" }])
  })

  it("at segment → mention", () => {
    const segs: OneBotSegment[] = [{ type: "at", data: { qq: "123456" } }]
    expect(fromOneBotSegments(segs, "v11")).toEqual([{ type: "mention", userId: "123456" }])
  })

  it("reply segment", () => {
    const segs: OneBotSegment[] = [{ type: "reply", data: { id: "9999" } }]
    expect(fromOneBotSegments(segs, "v11")).toEqual([
      { type: "reply", messageId: "9999", snippet: "" },
    ])
  })

  it("face segment → emoji", () => {
    const segs: OneBotSegment[] = [{ type: "face", data: { id: "14" } }]
    expect(fromOneBotSegments(segs, "v11")).toEqual([{ type: "emoji", code: "14" }])
  })

  it("record segment → voice", () => {
    const segs: OneBotSegment[] = [{ type: "record", data: { url: "https://a.com/v.amr" } }]
    expect(fromOneBotSegments(segs, "v11")).toEqual([{ type: "voice", url: "https://a.com/v.amr" }])
  })

  it("video segment", () => {
    const segs: OneBotSegment[] = [{ type: "video", data: { url: "https://a.com/v.mp4" } }]
    expect(fromOneBotSegments(segs, "v11")).toEqual([{ type: "video", url: "https://a.com/v.mp4" }])
  })

  it("file segment", () => {
    const segs: OneBotSegment[] = [
      { type: "file", data: { url: "https://a.com/f.pdf", name: "doc.pdf", size: 1024 } },
    ]
    expect(fromOneBotSegments(segs, "v11")).toEqual([
      {
        type: "file",
        url: "https://a.com/f.pdf",
        name: "doc.pdf",
        mimeType: "application/octet-stream",
        sizeBytes: 1024,
      },
    ])
  })

  it("unknown segment → text placeholder", () => {
    const segs: OneBotSegment[] = [{ type: "xml", data: { data: "<card/>" } }]
    const result = fromOneBotSegments(segs, "v11")
    expect(result[0].type).toBe("text")
    expect((result[0] as { type: "text"; text: string }).text).toContain("unsupported:xml")
  })

  it("handles mixed segment array", () => {
    const segs: OneBotSegment[] = [
      { type: "text", data: { text: "hi " } },
      { type: "at", data: { qq: "42" } },
    ]
    const result = fromOneBotSegments(segs, "v11")
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ type: "text", text: "hi " })
    expect(result[1]).toEqual({ type: "mention", userId: "42" })
  })
})

// ---------------------------------------------------------------------------
// fromOneBotSegments (v12)
// ---------------------------------------------------------------------------

describe("fromOneBotSegments v12", () => {
  it("text segment", () => {
    const segs: OneBotSegment[] = [{ type: "text", data: { text: "world" } }]
    expect(fromOneBotSegments(segs, "v12")).toEqual([{ type: "text", text: "world" }])
  })

  it("image uses file_id", () => {
    const segs: OneBotSegment[] = [{ type: "image", data: { file_id: "img-abc" } }]
    expect(fromOneBotSegments(segs, "v12")).toEqual([{ type: "image", url: "img-abc" }])
  })

  it("mention segment uses user_id", () => {
    const segs: OneBotSegment[] = [{ type: "mention", data: { user_id: "789" } }]
    expect(fromOneBotSegments(segs, "v12")).toEqual([{ type: "mention", userId: "789" }])
  })

  it("reply uses message_id", () => {
    const segs: OneBotSegment[] = [{ type: "reply", data: { message_id: "m-42" } }]
    expect(fromOneBotSegments(segs, "v12")).toEqual([
      { type: "reply", messageId: "m-42", snippet: "" },
    ])
  })

  it("voice uses file_id", () => {
    const segs: OneBotSegment[] = [{ type: "voice", data: { file_id: "v-file-id" } }]
    expect(fromOneBotSegments(segs, "v12")).toEqual([{ type: "voice", url: "v-file-id" }])
  })

  it("video uses file_id", () => {
    const segs: OneBotSegment[] = [{ type: "video", data: { file_id: "vid-id" } }]
    expect(fromOneBotSegments(segs, "v12")).toEqual([{ type: "video", url: "vid-id" }])
  })

  it("file uses file_id", () => {
    const segs: OneBotSegment[] = [
      { type: "file", data: { file_id: "file-id", name: "a.zip", size: 512 } },
    ]
    expect(fromOneBotSegments(segs, "v12")).toEqual([
      {
        type: "file",
        url: "file-id",
        name: "a.zip",
        mimeType: "application/octet-stream",
        sizeBytes: 512,
      },
    ])
  })

  it("unknown segment → text placeholder", () => {
    const segs: OneBotSegment[] = [{ type: "custom", data: {} }]
    const result = fromOneBotSegments(segs, "v12")
    expect(result[0].type).toBe("text")
    expect((result[0] as { type: "text"; text: string }).text).toContain("unsupported:custom")
  })
})

// ---------------------------------------------------------------------------
// toOneBotSegments (v11)
// ---------------------------------------------------------------------------

describe("toOneBotSegments v11", () => {
  it("text", () => {
    expect(toOneBotSegments([{ type: "text", text: "hi" }], "v11")).toEqual([
      { type: "text", data: { text: "hi" } },
    ])
  })

  it("markdown → text", () => {
    expect(toOneBotSegments([{ type: "markdown", md: "**bold**" }], "v11")).toEqual([
      { type: "text", data: { text: "**bold**" } },
    ])
  })

  it("image", () => {
    expect(toOneBotSegments([{ type: "image", url: "https://x.com/img.png" }], "v11")).toEqual([
      { type: "image", data: { file: "https://x.com/img.png" } },
    ])
  })

  it("mention → at", () => {
    expect(toOneBotSegments([{ type: "mention", userId: "55" }], "v11")).toEqual([
      { type: "at", data: { qq: "55" } },
    ])
  })

  it("reply", () => {
    expect(toOneBotSegments([{ type: "reply", messageId: "7", snippet: "" }], "v11")).toEqual([
      { type: "reply", data: { id: "7" } },
    ])
  })

  it("emoji → face", () => {
    expect(toOneBotSegments([{ type: "emoji", code: "14" }], "v11")).toEqual([
      { type: "face", data: { id: "14" } },
    ])
  })

  it("voice → record", () => {
    expect(toOneBotSegments([{ type: "voice", url: "https://a.com/v.amr" }], "v11")).toEqual([
      { type: "record", data: { file: "https://a.com/v.amr" } },
    ])
  })

  it("video", () => {
    expect(toOneBotSegments([{ type: "video", url: "https://a.com/v.mp4" }], "v11")).toEqual([
      { type: "video", data: { file: "https://a.com/v.mp4" } },
    ])
  })

  it("file", () => {
    expect(
      toOneBotSegments(
        [
          {
            type: "file",
            url: "https://a.com/f.pdf",
            name: "f.pdf",
            mimeType: "application/pdf",
            sizeBytes: 100,
          },
        ],
        "v11"
      )
    ).toEqual([{ type: "file", data: { file: "https://a.com/f.pdf", name: "f.pdf" } }])
  })

  it("unsupported segment is dropped", () => {
    expect(toOneBotSegments([{ type: "poll", question: "q?", options: ["a"] }], "v11")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// toOneBotSegments (v12)
// ---------------------------------------------------------------------------

describe("toOneBotSegments v12", () => {
  it("text", () => {
    expect(toOneBotSegments([{ type: "text", text: "hey" }], "v12")).toEqual([
      { type: "text", data: { text: "hey" } },
    ])
  })

  it("image uses file_id", () => {
    expect(toOneBotSegments([{ type: "image", url: "https://x.com/p.png" }], "v12")).toEqual([
      { type: "image", data: { file_id: "https://x.com/p.png" } },
    ])
  })

  it("mention uses user_id", () => {
    expect(toOneBotSegments([{ type: "mention", userId: "99" }], "v12")).toEqual([
      { type: "mention", data: { user_id: "99" } },
    ])
  })

  it("reply uses message_id", () => {
    expect(toOneBotSegments([{ type: "reply", messageId: "m-1", snippet: "" }], "v12")).toEqual([
      { type: "reply", data: { message_id: "m-1" } },
    ])
  })

  it("voice uses file_id", () => {
    expect(toOneBotSegments([{ type: "voice", url: "https://v.amr" }], "v12")).toEqual([
      { type: "voice", data: { file_id: "https://v.amr" } },
    ])
  })

  it("video uses file_id", () => {
    expect(toOneBotSegments([{ type: "video", url: "https://v.mp4" }], "v12")).toEqual([
      { type: "video", data: { file_id: "https://v.mp4" } },
    ])
  })

  it("file uses file_id", () => {
    expect(
      toOneBotSegments(
        [{ type: "file", url: "fid", name: "a.zip", mimeType: "application/zip", sizeBytes: 200 }],
        "v12"
      )
    ).toEqual([{ type: "file", data: { file_id: "fid", name: "a.zip" } }])
  })
})

// ---------------------------------------------------------------------------
// parseCqCodeString
// ---------------------------------------------------------------------------

describe("parseCqCodeString", () => {
  it("plain text with no CQ codes", () => {
    expect(parseCqCodeString("hello world", "v11")).toEqual([{ type: "text", text: "hello world" }])
  })

  it("single at CQ code", () => {
    const result = parseCqCodeString("[CQ:at,qq=123456]", "v11")
    expect(result).toEqual([{ type: "mention", userId: "123456" }])
  })

  it("mixed text + at", () => {
    const result = parseCqCodeString("hello [CQ:at,qq=42] how are you", "v11")
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ type: "text", text: "hello " })
    expect(result[1]).toEqual({ type: "mention", userId: "42" })
    expect(result[2]).toEqual({ type: "text", text: " how are you" })
  })

  it("image CQ code", () => {
    const result = parseCqCodeString("[CQ:image,url=https://x.com/a.png]", "v11")
    expect(result).toEqual([{ type: "image", url: "https://x.com/a.png" }])
  })

  it("reply CQ code", () => {
    const result = parseCqCodeString("[CQ:reply,id=777]", "v11")
    expect(result).toEqual([{ type: "reply", messageId: "777", snippet: "" }])
  })

  it("face CQ code → emoji", () => {
    const result = parseCqCodeString("[CQ:face,id=14]", "v11")
    expect(result).toEqual([{ type: "emoji", code: "14" }])
  })

  it("unescapes CQ special chars in text", () => {
    const result = parseCqCodeString("a&amp;b&#91;c&#93;", "v11")
    expect(result).toEqual([{ type: "text", text: "a&b[c]" }])
  })

  it("record CQ code → voice", () => {
    const result = parseCqCodeString("[CQ:record,url=https://voice.amr]", "v11")
    expect(result).toEqual([{ type: "voice", url: "https://voice.amr" }])
  })
})
