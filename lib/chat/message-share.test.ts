import type { UIMessage } from "ai"

import { buildMessageShareContent, writeMessageToClipboard } from "./message-share"

describe("buildMessageShareContent", () => {
  it("preserves ordered text, multiple images, files, and source links", () => {
    const message: UIMessage = {
      id: "mixed",
      role: "assistant",
      parts: [
        { type: "text", text: "See [docs](https://example.com/a_(b))." },
        {
          type: "file",
          url: "data:image/png;base64,YQ==",
          mediaType: "image/png",
          filename: "first.png",
        },
        {
          type: "file",
          url: "https://cdn.example.com/second.jpg",
          mediaType: "image/jpeg",
          filename: "second.jpg",
        },
        {
          type: "file",
          url: "https://files.example.com/report.pdf",
          mediaType: "application/pdf",
          filename: "report.pdf",
        },
        { type: "source-url", url: "https://source.example.com", title: "Source" },
      ] as UIMessage["parts"],
    }

    const content = buildMessageShareContent(message)

    expect(content.plainText).toBe(
      [
        "See [docs](https://example.com/a_(b)).",
        "![first.png](data:image/png;base64,YQ==)",
        "![second.jpg](https://cdn.example.com/second.jpg)",
        "[report.pdf](https://files.example.com/report.pdf)",
        "[Source](https://source.example.com)",
      ].join("\n\n")
    )
    expect(content.nativeShareText).toContain("See [docs](https://example.com/a_(b)).")
    expect(content.nativeShareText).toContain("first.png")
    expect(content.nativeShareText).not.toContain("data:image/png;base64")
    expect(content.nativeShareText).toContain("[Source](https://source.example.com)")
    expect(content.html).toContain('<img src="data:image/png;base64,YQ==" alt="first.png"')
    expect(content.html).toContain('<a href="https://example.com/a_(b)"')
    expect(content.html).toContain(">docs</a>.")
    expect(content.html).toContain('<img src="https://cdn.example.com/second.jpg" alt="second.jpg"')
    expect(content.html).toContain('<a href="https://files.example.com/report.pdf">report.pdf</a>')
    expect(content.shareFiles).toHaveLength(1)
    expect(content.shareFiles[0]).toMatchObject({ name: "first.png", type: "image/png" })
  })

  it("reports content for an image-only message", () => {
    const message: UIMessage = {
      id: "image-only",
      role: "user",
      parts: [
        {
          type: "file",
          url: "data:image/png;base64,YQ==",
          mediaType: "image/png",
          filename: "photo.png",
        },
      ],
    }

    expect(buildMessageShareContent(message).hasContent).toBe(true)
  })

  it("keeps malformed image data copyable without crashing message rendering", () => {
    const message: UIMessage = {
      id: "malformed-image",
      role: "user",
      parts: [
        {
          type: "file",
          url: "data:image/png;base64,%%%",
          mediaType: "image/png",
          filename: "broken.png",
        },
      ],
    }

    expect(() => buildMessageShareContent(message)).not.toThrow()
    expect(buildMessageShareContent(message)).toMatchObject({ hasContent: true, shareFiles: [] })
  })

  it("writes one rich clipboard item containing every image", async () => {
    const write = jest.fn().mockResolvedValue(undefined)
    const writeText = jest.fn().mockResolvedValue(undefined)
    class TestClipboardItem {
      constructor(readonly entries: Record<string, Blob>) {}
    }
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { write, writeText } },
    })
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: TestClipboardItem,
    })
    const content = buildMessageShareContent({
      id: "two-images",
      role: "user",
      parts: [
        { type: "file", url: "data:image/png;base64,YQ==", mediaType: "image/png" },
        { type: "file", url: "data:image/png;base64,Yg==", mediaType: "image/png" },
      ],
    })

    await expect(writeMessageToClipboard(content)).resolves.toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
    const item = write.mock.calls[0][0][0] as TestClipboardItem
    await expect(item.entries["text/html"].text()).resolves.toContain("data:image/png;base64,Yg==")
    expect(writeText).not.toHaveBeenCalled()
  })

  it("falls back to plain text when rich clipboard writing fails", async () => {
    const write = jest.fn().mockRejectedValue(new Error("unsupported"))
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { write, writeText } },
    })
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: class {
        constructor(_entries: Record<string, Blob>) {}
      },
    })
    const content = buildMessageShareContent({
      id: "text",
      role: "assistant",
      parts: [{ type: "text", text: "hello" }],
    })

    await expect(writeMessageToClipboard(content)).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith("hello")
  })
})
