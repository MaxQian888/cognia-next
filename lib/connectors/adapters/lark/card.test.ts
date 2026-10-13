import {
  buildLarkCommandFrame,
  buildLarkCommandReply,
  escapeLarkMarkdown,
  segmentToLarkBody,
  segmentsToLarkBody,
} from "./card"

describe("escapeLarkMarkdown", () => {
  // Card markdown escapes with HTML entities; a backslash renders as itself,
  // which is how "\\@机器人" once reached a chat.
  it("writes markdown syntax as entities, never as backslashes", () => {
    expect(escapeLarkMarkdown("a\\b *x* _y_ [l](u)")).toBe(
      "a&#92;b &#42;x&#42; &#95;y&#95; &#91;l&#93;&#40;u&#41;"
    )
  })

  it("leaves @ alone: a card only mentions through an <at> tag", () => {
    expect(escapeLarkMarkdown("群聊中 @机器人")).toBe("群聊中 @机器人")
  })

  it("disarms tags so text cannot mention anyone", () => {
    expect(escapeLarkMarkdown("<at id=all></at>")).toBe("&#60;at id=all&#62;&#60;/at&#62;")
  })

  it("handles empty string", () => {
    expect(escapeLarkMarkdown("")).toBe("")
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
    const content = JSON.parse(body!.content)
    expect(content.schema).toBe("2.0")
    expect(content.body.elements[0]).toMatchObject({ tag: "markdown", content: "**bold** text" })
  })

  it("markdown segment renders as markdown and only disarms mentions", () => {
    const body = segmentToLarkBody({ type: "markdown", md: "hey @user **bold** <at id=all></at>" })
    const content = JSON.parse(body!.content).body.elements[0].content
    expect(content).toContain("hey @user **bold**")
    expect(content).not.toMatch(/<at\b/)
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

  it("mention segment → documented <at user_id=…> syntax with display-name fallback text", () => {
    const body = segmentToLarkBody({
      type: "mention",
      userId: "ou_user_abc",
      displayName: "Alice",
    })
    expect(body!.msg_type).toBe("text")
    const content = JSON.parse(body!.content) as { text: string }
    expect(content.text).toBe('<at user_id="ou_user_abc">Alice</at>')
  })

  it("mention segment without displayName keeps an empty fallback text", () => {
    const body = segmentToLarkBody({ type: "mention", userId: "ou_user_abc" })
    const content = JSON.parse(body!.content) as { text: string }
    expect(content.text).toBe('<at user_id="ou_user_abc"></at>')
  })

  it("card segment with foreign dialect → text [card] placeholder", () => {
    const body = segmentToLarkBody({
      type: "card",
      card: { kind: "block_kit", payload: { type: "section" } },
    })
    expect(body!.msg_type).toBe("text")
    const content = JSON.parse(body!.content) as { text: string }
    expect(content.text).toBe("[card]")
  })

  it("card segment with Lark card JSON (elements) → passthrough interactive body", () => {
    const payload = { elements: [{ tag: "div", text: { tag: "lark_md", content: "hi" } }] }
    const body = segmentToLarkBody({ type: "card", card: { kind: "lark", payload } })
    expect(body!.msg_type).toBe("interactive")
    expect(JSON.parse(body!.content)).toEqual(payload)
  })

  it("card segment with Card 2.0 schema marker → passthrough interactive body", () => {
    const payload = { schema: "2.0", body: { elements: [] } }
    const body = segmentToLarkBody({ type: "card", card: { kind: "lark", payload } })
    expect(body!.msg_type).toBe("interactive")
    expect(JSON.parse(body!.content)).toEqual(payload)
  })

  it("file segment with remote URL → text with link (degraded)", () => {
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

  it("file segment with resolved file_key → msg_type file with file_key + file_name", () => {
    const body = segmentToLarkBody({
      type: "file",
      url: "file_v3_uploaded_pdf",
      name: "doc.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
    })
    expect(body!.msg_type).toBe("file")
    const content = JSON.parse(body!.content) as { file_key: string; file_name: string }
    expect(content.file_key).toBe("file_v3_uploaded_pdf")
    expect(content.file_name).toBe("doc.pdf")
  })

  it("voice segment with resolved file_key → msg_type audio", () => {
    const body = segmentToLarkBody({ type: "voice", url: "file_v3_voice_abc" })
    expect(body!.msg_type).toBe("audio")
    const content = JSON.parse(body!.content) as { file_key: string }
    expect(content.file_key).toBe("file_v3_voice_abc")
  })

  it("voice segment with remote URL → text-link fallback (degraded, not silent)", () => {
    const body = segmentToLarkBody({ type: "voice", url: "https://example.com/audio.opus" })
    expect(body!.msg_type).toBe("text")
    const content = JSON.parse(body!.content) as { text: string }
    expect(content.text).toContain("https://example.com/audio.opus")
  })

  it("video segment with resolved file_key → msg_type media", () => {
    const body = segmentToLarkBody({ type: "video", url: "file_v3_video_xyz" })
    expect(body!.msg_type).toBe("media")
    const content = JSON.parse(body!.content) as { file_key: string }
    expect(content.file_key).toBe("file_v3_video_xyz")
  })

  it("video segment with remote URL → text-link fallback", () => {
    const body = segmentToLarkBody({ type: "video", url: "https://example.com/clip.mp4" })
    expect(body!.msg_type).toBe("text")
    const content = JSON.parse(body!.content) as { text: string }
    expect(content.text).toContain("https://example.com/clip.mp4")
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

describe("command Card 2.0 presentation", () => {
  it.each(["commands", "status", "sessions", "dir", "tasks", "agent"])(
    "uses the shared information frame for /%s",
    (command) => {
      const segment = buildLarkCommandReply(
        command,
        "会话 / session: 青松\n模型 / model: muse1.3",
        "applied"
      )
      const body = segmentToLarkBody(segment)!
      expect(body.msg_type).toBe("interactive")
      const card = JSON.parse(body.content)
      expect(card.schema).toBe("2.0")
      expect(card.header.template).toBe("wathet")
      expect(card.header.icon.tag).toBe("standard_icon")
      expect(card.header.subtitle.content).toBe(`/${command}`)
      expect(card.body.padding).toBe("12px 16px 16px 16px")
      expect(JSON.stringify(card.body)).toContain("muse1.3")
      expect(card.elements).toBeUndefined()
    }
  )
  it("distinguishes confirmations and denials without depending only on color", () => {
    expect(buildLarkCommandFrame("Done", [], "success")).toHaveProperty("header.template", "green")
    const denied = segmentToLarkBody(buildLarkCommandReply("model", "No permission", "denied"))!
    const card = JSON.parse(denied.content)
    expect(card.header.title.content).toBe("未执行")
    expect(card.header.template).toBe("orange")
    expect(card.header.icon.token).toBe("safe_outlined")
    expect(JSON.stringify(card.body)).toContain("No permission")
  })
  it("escapes dynamic mention and formatting syntax and preserves long output", () => {
    const text = "<at id=all></at> **title** " + "line\n".repeat(220)
    const card = JSON.parse(
      segmentToLarkBody(buildLarkCommandReply("sessions", text, "applied"))!.content
    )
    expect(card.body.elements).toHaveLength(1)
    expect(card.body.elements[0].content).toContain("&#60;at id=all&#62;")
    expect(card.body.elements[0].content).toContain("&#42;&#42;title&#42;&#42;")
    expect(card.body.elements[0].content).not.toContain("<at")
    expect(card.body.elements[0].content.split("line")).toHaveLength(221)
  })
})

it("passes official template card payloads through without treating them as foreign cards", () => {
  const payload = {
    type: "template",
    data: {
      template_id: "AAqkKc",
      template_version_name: "1.0.0",
      template_variable: { answer: "Ready" },
    },
  }
  const body = segmentToLarkBody({ type: "card", card: { kind: "lark", payload } })
  expect(body?.msg_type).toBe("interactive")
  expect(JSON.parse(body!.content)).toEqual(payload)
})
