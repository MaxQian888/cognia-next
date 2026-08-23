import JSZip from "jszip"
import { UploadContentInspectionError, inspectUploadContent } from "./upload-content-inspection"

async function zip(entries: Record<string, string>): Promise<Uint8Array> {
  const archive = new JSZip()
  for (const [path, content] of Object.entries(entries)) archive.file(path, content)
  return archive.generateAsync({ type: "uint8array", compression: "DEFLATE" })
}

describe("inspectUploadContent", () => {
  it("recognizes PDF and OOXML from bytes instead of trusting the label", async () => {
    expect(
      inspectUploadContent({
        name: "report.pdf",
        declaredMediaType: "application/octet-stream",
        bytes: new TextEncoder().encode("%PDF-1.7\nbody"),
      })
    ).toEqual({ mediaType: "application/pdf", archive: false })

    const docx = await zip({
      "[Content_Types].xml": "<Types />",
      "word/document.xml": "<w:document />",
    })
    expect(
      inspectUploadContent({
        name: "review.docx",
        declaredMediaType: "application/zip",
        bytes: docx,
      })
    ).toEqual({
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      archive: true,
    })
  })

  it("rejects executable, EICAR, active SVG, and macro payloads", async () => {
    expect(() =>
      inspectUploadContent({
        name: "notes.txt",
        declaredMediaType: "text/plain",
        bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0x00]),
      })
    ).toThrow(expect.objectContaining({ code: "malicious_content" }))

    expect(() =>
      inspectUploadContent({
        name: "notes.txt",
        declaredMediaType: "text/plain",
        bytes: new TextEncoder().encode(
          "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
        ),
      })
    ).toThrow(expect.objectContaining({ code: "malicious_content" }))

    expect(() =>
      inspectUploadContent({
        name: "diagram.svg",
        declaredMediaType: "image/svg+xml",
        bytes: new TextEncoder().encode("<svg><script>alert(1)</script></svg>"),
      })
    ).toThrow(expect.objectContaining({ code: "malicious_content" }))

    const macro = await zip({
      "[Content_Types].xml": "<Types />",
      "word/document.xml": "<w:document />",
      "word/vbaProject.bin": "macro",
    })
    expect(() =>
      inspectUploadContent({
        name: "review.docm",
        declaredMediaType: "application/zip",
        bytes: macro,
      })
    ).toThrow(expect.objectContaining({ code: "malicious_content" }))
  })

  it("rejects mislabeled binary documents and archive bombs", async () => {
    expect(() =>
      inspectUploadContent({
        name: "report.pdf",
        declaredMediaType: "application/pdf",
        bytes: new TextEncoder().encode("not a pdf"),
      })
    ).toThrow(expect.objectContaining({ code: "type_mismatch" }))

    const bomb = await zip({ "word/document.xml": "A".repeat(300_000) })
    expect(() =>
      inspectUploadContent({
        name: "bomb.docx",
        declaredMediaType: "application/zip",
        bytes: bomb,
      })
    ).toThrow(expect.objectContaining({ code: "unsafe_archive" }))
  })

  it("exposes stable machine-readable inspection errors", () => {
    const error = new UploadContentInspectionError("type_mismatch")
    expect(error.code).toBe("type_mismatch")
    expect(error.message).toBe("type_mismatch")
  })
})
