import { escapeLarkMarkdown, segmentToLarkBody, segmentsToLarkBody } from "./card"

describe("escapeLarkMarkdown", () => {
  it("escapes backslash", () => {
    expect(escapeLarkMarkdown("a\\b")).toBe("a\\\\b")
  })

  it("escapes @ signs", () => {
    expect(escapeLarkMarkdown("hello @user")).toBe("hello \\@user")
  })

  it("passes through **bold** and *italic* unchanged", () => {
    expect(escapeLarkMarkdown("**bold** and *italic*")).toBe("**bold** and *italic*")
  })

  it("passes through [link](url) unchanged", () => {
    expect(escapeLarkMarkdown("[link](https://example.com)")).toBe("[link](https://example.com)")
  })

  it("handles empty string", () => {
    expect(escapeLarkMarkdown("")).toBe("")
  })

  it("escapes multiple @ and backslash in one string", () => {
    expect(escapeLarkMarkdown("@all \\n @user")).toBe("\\@all \\\\n \\@user")
  })
})

describe("segmentToLarkBody", () => {
  it("text segment → msg_type text with content.text", () => {
    const body = segmentToLarkBody({ type: "text", text: "hello world" })
    expect(body).not.toBeNull()
    expect(body!.msg_type).toBe("text")
    const content = JSON.parse(body!.content) as { text: string }
    expect(content.text).toBe("hello world")
  })

  it("markdown segment → msg_type interactive with lark_md", () => {
    const body = segmentToLarkBody({ type: "markdown", md: "**bold** text" })
    expect(body).not.toBeNull()
    expect(body!.msg_type).toBe("interactive")
    const content = JSON.parse(body!.content) as {
      elements: Array<{ text: { content: string; tag: string } }>
    }
    expect(content.elements[0].text.tag).toBe("lark_md")
    expect(content.elements[0].text.content).toContain("**bold**")
  })

  it("markdown segment escapes @ in content", () => {
    const body = segmentToLarkBody({ type: "markdown", md: "hey @user" })
    const content = JSON.parse(body!.content) as {
      elements: Array<{ text: { content: string } }>
    }
    expect(content.elements[0].text.content).toContain("\\@user")
  })

  it("image segment with image_key → msg_type image", () => {
    const body = segmentToLarkBody({ type: "image", url: "img_v3_abc123", alt: "photo" })
    expect(body!.msg_type).toBe("image")
    const content = JSON.parse(body!.content) as { image_key: string }
    expect(content.image_key).toBe("img_v3_abc123")
  })

  it("image segment with https url → text message with link", () => {
    const body = segmentToLarkBody({ type: "image", url: "https://example.com/img.png", alt: "x" })
    expect(body!.msg_type).toBe("text")
    const content = JSON.parse(body!.content) as { text: string }
    expect(content.text).toContain("https://example.com/img.png")
  })

  it("code segment with language → triple-backtick block", () => {
    const body = segmentToLarkBody({ type: "code", code: "print('hi')", language: "python" })
    expect(body!.msg_type).toBe("text")
    const content = JSON.parse(body!.content) as { text: string }
    expect(content.text).toContain("```python")
    expect(content.text).toContain("print('hi')")
  })

  it("code segment without language → plain backtick block", () => {
    const body = segmentToLarkBody({ type: "code", code: "select 1" })
    const content = JSON.parse(body!.content) as { text: string }
    expect(content.text).toContain("```\nselect 1")
  })

  it("mention segment → text with open_id tag", () => {
    const body = segmentToLarkBody({ type: "mention", userId: "ou_user_abc" })
    expect(body!.msg_type).toBe("text")
    const content = JSON.parse(body!.content) as { text: string }
    expect(content.text).toContain("ou_user_abc")
  })

  it("card segment → text [card] placeholder", () => {
    const body = segmentToLarkBody({
      type: "card",
      card: { kind: "block_kit", payload: { type: "section" } },
    })
    expect(body!.msg_type).toBe("text")
    const content = JSON.parse(body!.content) as { text: string }
    expect(content.text).toBe("[card]")
  })

  it("file segment → text with link", () => {
    const body = segmentToLarkBody({
      type: "file",
      url: "https://example.com/doc.pdf",
      name: "doc.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
    })
    expect(body!.msg_type).toBe("text")
    const content = JSON.parse(body!.content) as { text: string }
    expect(content.text).toContain("doc.pdf")
    expect(content.text).toContain("https://example.com/doc.pdf")
  })

  it("voice segment → null (unsupported)", () => {
    expect(segmentToLarkBody({ type: "voice", url: "https://example.com/audio.ogg" })).toBeNull()
  })

  it("emoji segment → null (unsupported)", () => {
    expect(segmentToLarkBody({ type: "emoji", code: "thumbsup" })).toBeNull()
  })
})

describe("segmentsToLarkBody", () => {
  it("single text segment → text body", () => {
    const body = segmentsToLarkBody([{ type: "text", text: "hi" }])
    expect(body.msg_type).toBe("text")
  })

  it("multiple text segments → combined text body", () => {
    const body = segmentsToLarkBody([
      { type: "text", text: "line one" },
      { type: "text", text: "line two" },
    ])
    expect(body.msg_type).toBe("text")
    const content = JSON.parse(body.content) as { text: string }
    expect(content.text).toContain("line one")
    expect(content.text).toContain("line two")
  })

  it("empty segments → text [empty]", () => {
    const body = segmentsToLarkBody([])
    expect(body.msg_type).toBe("text")
    const content = JSON.parse(body.content) as { text: string }
    expect(content.text).toBe("[empty]")
  })

  it("mixed image + text → combined text body", () => {
    const body = segmentsToLarkBody([
      { type: "text", text: "look:" },
      { type: "image", url: "img_v3_abc", alt: "x" },
    ])
    expect(body.msg_type).toBe("text")
    const content = JSON.parse(body.content) as { text: string }
    expect(content.text).toContain("look:")
    expect(content.text).toContain("[image]")
  })
})
