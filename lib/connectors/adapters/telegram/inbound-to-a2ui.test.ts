import { telegramInboundToA2UI } from "./inbound-to-a2ui"

describe("telegramInboundToA2UI", () => {
  it("returns null on empty payload", () => {
    expect(telegramInboundToA2UI({})).toBeNull()
  })

  it("maps plain text", () => {
    const out = telegramInboundToA2UI({ text: "hi" })
    expect(out!.body).toEqual([{ kind: "text", text: "hi" }])
  })

  it("maps inline keyboard rows to button rows", () => {
    const out = telegramInboundToA2UI({
      text: "Pick one",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Yes", callback_data: "yes" },
            { text: "No", callback_data: "no" },
          ],
          [{ text: "Docs", url: "https://example.com" }],
        ],
      },
    })
    expect(out!.body).toEqual([
      { kind: "text", text: "Pick one" },
      {
        kind: "row",
        children: [
          { kind: "button", label: "Yes", actionId: "yes", url: undefined },
          { kind: "button", label: "No", actionId: "no", url: undefined },
        ],
      },
      {
        kind: "row",
        children: [
          { kind: "button", label: "Docs", url: "https://example.com", actionId: undefined },
        ],
      },
    ])
  })

  it("maps photo by selecting the biggest size", () => {
    const out = telegramInboundToA2UI({
      photo: [
        { file_id: "small", width: 100, height: 100 },
        { file_id: "big", width: 400, height: 400 },
      ],
      caption: "look",
    })
    expect(out!.body[0]).toEqual({
      kind: "image",
      url: "telegram-file:big",
      alt: "look",
      width: 400,
      height: 400,
    })
  })

  it("maps document attachments to link nodes", () => {
    const out = telegramInboundToA2UI({
      document: { file_id: "doc1", file_name: "report.pdf", mime_type: "application/pdf" },
    })
    expect(out!.body[0]).toEqual({
      kind: "link",
      href: "telegram-file:doc1",
      label: "report.pdf",
    })
  })

  it("maps web_app and login_url buttons into url buttons", () => {
    const out = telegramInboundToA2UI({
      text: "x",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "WebApp", web_app: { url: "https://example.com/wa" } },
            { text: "Login", login_url: { url: "https://example.com/login" } },
          ],
        ],
      },
    })
    const row = out!.body.find((n) => n.kind === "row") as { children: Array<{ url?: string }> }
    expect(row.children[0].url).toBe("https://example.com/wa")
    expect(row.children[1].url).toBe("https://example.com/login")
  })
})
