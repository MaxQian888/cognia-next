/**
 * Coverage for `dispatch.ts`. Pure logic, so the tests stay tight.
 */

import { detectSourceFormat, dispatchSource, listSupportedFormats } from "./dispatch"

describe("dispatchSource", () => {
  it("routes document formats to the document processor", () => {
    const result = dispatchSource("markdown")
    expect(result.routesToDocumentProcessor).toBe(true)
    expect(result.kind).toBe("document")
  })

  it("routes PDF / docx / pptx to the document processor as documents", () => {
    expect(dispatchSource("pdf").kind).toBe("document")
    expect(dispatchSource("docx").kind).toBe("document")
    expect(dispatchSource("pptx").kind).toBe("document")
  })

  it("classifies code as the code kind even though parsed by document-processor", () => {
    const code = dispatchSource("code")
    expect(code.kind).toBe("code")
    expect(code.routesToDocumentProcessor).toBe(true)
  })

  it("routes mbox / eml to the email importer family", () => {
    expect(dispatchSource("mbox").importerKey).toBe("email/mbox")
    expect(dispatchSource("eml").importerKey).toBe("email/eml")
    expect(dispatchSource("eml").kind).toBe("email")
  })

  it("routes git-repo to code-repo importer", () => {
    const r = dispatchSource("git-repo")
    expect(r.importerKey).toBe("code-repo/git-repo")
    expect(r.kind).toBe("code")
    expect(r.routesToDocumentProcessor).toBe(false)
  })

  it("routes chat exports to their own importer keys", () => {
    expect(dispatchSource("slack-export").importerKey).toBe("chat-export/slack")
    expect(dispatchSource("lark-export").importerKey).toBe("chat-export/lark")
    expect(dispatchSource("chatgpt-export").importerKey).toBe("chat-export/chatgpt")
    expect(dispatchSource("wechat-export").kind).toBe("chat")
  })

  it("throws on unknown formats", () => {
    expect(() => dispatchSource("not-real" as never)).toThrow(/Unknown twin source format/)
  })
})

describe("detectSourceFormat", () => {
  it.each([
    ["notes.md", "markdown"],
    ["paper.pdf", "pdf"],
    ["report.docx", "docx"],
    ["deck.pptx", "pptx"],
    ["letter.odt", "odt"],
    ["page.html", "html"],
    ["slides.htm", "html"],
    ["data.csv", "csv"],
    ["book.epub", "epub"],
    ["script.ts", "code"],
    ["app.tsx", "code"],
    ["main.py", "code"],
    ["server.go", "code"],
    ["mailbox.mbox", "mbox"],
    ["msg.eml", "eml"],
  ])("maps %s to %s", (filename, expected) => {
    expect(detectSourceFormat(filename)).toBe(expected)
  })

  it("returns undefined for filenames without a known extension", () => {
    expect(detectSourceFormat("README")).toBeUndefined()
    expect(detectSourceFormat("noext.")).toBeUndefined()
    expect(detectSourceFormat("strange.zzz")).toBeUndefined()
  })
})

describe("listSupportedFormats", () => {
  it("includes every TwinSourceFormat in the dispatcher", () => {
    const formats = listSupportedFormats()
    expect(formats.length).toBeGreaterThanOrEqual(15)
    expect(formats).toContain("markdown")
    expect(formats).toContain("pdf")
    expect(formats).toContain("git-repo")
    expect(formats).toContain("mbox")
  })
})
