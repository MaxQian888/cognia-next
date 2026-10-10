import { FILE_TYPE_ICON_KINDS } from "@/lib/files/file-type-icon"

import { FILES_FORMATS, filesFormatOf, formatOfIconKind } from "./format"
import type { FilesEntry } from "./types"

type FormatInput = Parameters<typeof filesFormatOf>[0]

function upload(
  sourceTitle: string,
  mediaType?: string,
  kind: FilesEntry["kind"] = "upload"
): FormatInput {
  return { kind, title: sourceTitle, sourceTitle, ...(mediaType ? { mediaType } : {}) }
}

describe("formatOfIconKind", () => {
  it("maps every icon kind to a known format", () => {
    expect(FILE_TYPE_ICON_KINDS.length).toBeGreaterThan(0)
    for (const kind of FILE_TYPE_ICON_KINDS) {
      expect(FILES_FORMATS).toContain(formatOfIconKind(kind))
    }
  })

  it("maps representative kinds", () => {
    expect(formatOfIconKind("typescript")).toBe("code")
    expect(formatOfIconKind("html")).toBe("code")
    expect(formatOfIconKind("json")).toBe("data")
    expect(formatOfIconKind("spreadsheet")).toBe("data")
    expect(formatOfIconKind("markdown")).toBe("document")
    expect(formatOfIconKind("pdf")).toBe("document")
    expect(formatOfIconKind("presentation")).toBe("document")
    expect(formatOfIconKind("image")).toBe("image")
    expect(formatOfIconKind("video")).toBe("video")
    expect(formatOfIconKind("audio")).toBe("audio")
    expect(formatOfIconKind("archive")).toBe("archive")
    expect(formatOfIconKind("package")).toBe("archive")
    expect(formatOfIconKind("font")).toBe("other")
    expect(formatOfIconKind("file")).toBe("other")
    expect(formatOfIconKind("folder")).toBe("other")
  })
})

describe("filesFormatOf", () => {
  it("classifies chat images as images", () => {
    expect(filesFormatOf({ kind: "image", title: "", sourceTitle: "" })).toBe("image")
  })

  it("classifies uploads of both kinds by filename", () => {
    expect(filesFormatOf(upload("report.pdf"))).toBe("document")
    expect(filesFormatOf(upload("notes.md"))).toBe("document")
    expect(filesFormatOf(upload("main.rs"))).toBe("code")
    expect(filesFormatOf(upload("data.json"))).toBe("data")
    expect(filesFormatOf(upload("budget.xlsx"))).toBe("data")
    expect(filesFormatOf(upload("photo.png"))).toBe("image")
    expect(filesFormatOf(upload("clip.mp4"))).toBe("video")
    expect(filesFormatOf(upload("song.mp3"))).toBe("audio")
    expect(filesFormatOf(upload("bundle.zip"))).toBe("archive")
    expect(filesFormatOf(upload("SPEC.md", undefined, "session-upload"))).toBe("document")
  })

  it("prefers the source's filename over a display name", () => {
    expect(filesFormatOf({ kind: "upload", title: "Renamed", sourceTitle: "deck.pdf" })).toBe(
      "document"
    )
    expect(filesFormatOf({ kind: "upload", title: "photo.png", sourceTitle: "" })).toBe("image")
  })

  it("falls back to the media type when the filename says nothing", () => {
    expect(filesFormatOf(upload("blob", "image/webp"))).toBe("image")
    expect(filesFormatOf(upload("blob", "VIDEO/MP4"))).toBe("video")
    expect(filesFormatOf(upload("blob", "audio/ogg"))).toBe("audio")
    expect(filesFormatOf(upload("blob", "text/plain"))).toBe("document")
    expect(filesFormatOf(upload("blob", "application/pdf"))).toBe("document")
    expect(filesFormatOf(upload("blob", "application/json"))).toBe("data")
    expect(filesFormatOf(upload("blob", "application/ld+json"))).toBe("data")
    expect(filesFormatOf(upload("blob", "text/csv"))).toBe("document")
    expect(filesFormatOf(upload("blob", "application/csv"))).toBe("data")
    expect(filesFormatOf(upload("blob", "application/zip"))).toBe("archive")
    expect(filesFormatOf(upload("blob", "application/x-7z-compressed"))).toBe("archive")
    expect(filesFormatOf(upload("blob", "application/x-tar"))).toBe("archive")
    expect(filesFormatOf(upload("blob", "application/octet-stream"))).toBe("other")
    expect(filesFormatOf(upload("blob"))).toBe("other")
  })

  it("classifies artifacts by type, then language", () => {
    const artifact = (subtype?: string, language?: string): FormatInput => ({
      kind: "artifact",
      title: "x",
      sourceTitle: "x",
      ...(subtype ? { subtype } : {}),
      ...(language ? { language } : {}),
    })
    expect(filesFormatOf(artifact("document"))).toBe("document")
    expect(filesFormatOf(artifact("jupyter"))).toBe("document")
    for (const type of ["svg", "mermaid", "chart", "math"]) {
      expect(filesFormatOf(artifact(type))).toBe("diagram")
    }
    expect(filesFormatOf(artifact("code", "json"))).toBe("data")
    expect(filesFormatOf(artifact("code", "yaml"))).toBe("data")
    expect(filesFormatOf(artifact("code", "xml"))).toBe("data")
    expect(filesFormatOf(artifact("code", "typescript"))).toBe("code")
    expect(filesFormatOf(artifact("html"))).toBe("code")
    expect(filesFormatOf(artifact())).toBe("code")
  })

  it("classifies canvas documents by type, then language", () => {
    const canvas = (subtype?: string, language?: string): FormatInput => ({
      kind: "canvas",
      title: "x",
      sourceTitle: "x",
      ...(subtype ? { subtype } : {}),
      ...(language ? { language } : {}),
    })
    expect(filesFormatOf(canvas("text"))).toBe("document")
    expect(filesFormatOf(canvas("code", "markdown"))).toBe("document")
    expect(filesFormatOf(canvas("code", "plaintext"))).toBe("document")
    expect(filesFormatOf(canvas("code", "latex"))).toBe("document")
    expect(filesFormatOf(canvas("code", "json"))).toBe("data")
    expect(filesFormatOf(canvas("code", "python"))).toBe("code")
    expect(filesFormatOf(canvas())).toBe("code")
  })
})
