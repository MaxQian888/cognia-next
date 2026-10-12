import { gzipSync } from "fflate"
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

interface TarEntry {
  name: string
  type?: string
  data?: string
  link?: string
}

/** A minimal ustar writer: enough to state each header field on purpose. */
function tar(entries: TarEntry[], options: { badChecksum?: boolean; noEnd?: boolean } = {}) {
  const blocks: Uint8Array[] = []
  const encoder = new TextEncoder()
  const field = (header: Uint8Array, offset: number, length: number, value: string) => {
    header.set(encoder.encode(value).subarray(0, length), offset)
  }
  for (const entry of entries) {
    const data = encoder.encode(entry.data ?? "")
    const header = new Uint8Array(512)
    field(header, 0, 100, entry.name)
    field(header, 100, 8, "0000644\0")
    field(header, 124, 12, `${data.byteLength.toString(8).padStart(11, "0")}\0`)
    field(header, 156, 1, entry.type ?? "0")
    field(header, 157, 100, entry.link ?? "")
    field(header, 257, 6, "ustar\0")
    field(header, 263, 2, "00")
    header.fill(0x20, 148, 156)
    let sum = header.reduce((total, byte) => total + byte, 0)
    if (options.badChecksum) sum += 1
    field(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `)
    blocks.push(header)
    const padded = new Uint8Array(Math.ceil(data.byteLength / 512) * 512)
    padded.set(data)
    blocks.push(padded)
  }
  if (!options.noEnd) blocks.push(new Uint8Array(1024))
  const out = new Uint8Array(blocks.reduce((total, block) => total + block.byteLength, 0))
  let at = 0
  for (const block of blocks) {
    out.set(block, at)
    at += block.byteLength
  }
  return out
}

describe("tar archives (ADR-0224 A11b)", () => {
  const inspect = (name: string, bytes: Uint8Array) =>
    inspectUploadContent({ name, declaredMediaType: "application/octet-stream", bytes })
  const code = (fn: () => unknown) => {
    try {
      fn()
    } catch (error) {
      return (error as UploadContentInspectionError).code
    }
    return null
  }

  it("accepts files, folders and links that stay inside, plain or gzipped", () => {
    const archive = tar([
      { name: "src/", type: "5" },
      { name: "src/main.ts", data: "export {}\n" },
      { name: "src/link.ts", type: "2", link: "main.ts" },
      { name: "docs/up.md", type: "2", link: "../src/main.ts" },
    ])
    expect(inspect("code.tar", archive)).toEqual({ mediaType: "application/x-tar", archive: true })
    expect(inspect("code.tar.gz", gzipSync(archive))).toEqual({
      mediaType: "application/gzip",
      archive: true,
    })
    expect(inspect("code.tgz", gzipSync(archive)).archive).toBe(true)
  })

  it("refuses entries that reach outside the archive or are not files", () => {
    for (const entries of [
      [{ name: "../escape.txt", data: "x" }],
      [{ name: "/etc/passwd", data: "x" }],
      [{ name: "link", type: "2", link: "/etc/passwd" }],
      [{ name: "a/link", type: "2", link: "../../outside" }],
      [{ name: "hard", type: "1", link: "a.txt" }],
      [{ name: "dev", type: "3" }],
    ]) {
      expect(code(() => inspect("bad.tar", tar(entries)))).toBe("unsafe_archive")
    }
  })

  it("reads names a pax header carries, and checks them too", () => {
    const pax = (path: string) => {
      const record = ` path=${path}\n`
      const length = record.length + String(record.length + 2).length
      return `${length}${record}`
    }
    const ok = tar([
      { name: "PaxHeader", type: "x", data: pax("a/very/long/name.txt") },
      { name: "short", data: "x" },
    ])
    expect(inspect("long.tar", ok).archive).toBe(true)
    const escaping = tar([
      { name: "PaxHeader", type: "x", data: pax("../../escape.txt") },
      { name: "short", data: "x" },
    ])
    expect(code(() => inspect("escape.tar", escaping))).toBe("unsafe_archive")
  })

  it("refuses a damaged, truncated or mislabeled archive", () => {
    const entries = [{ name: "a.txt", data: "a" }]
    expect(code(() => inspect("bad.tar", tar(entries, { badChecksum: true })))).toBe(
      "unsafe_archive"
    )
    expect(code(() => inspect("cut.tar", tar(entries, { noEnd: true }).subarray(0, 700)))).toBe(
      "unsafe_archive"
    )
    expect(code(() => inspect("notes.txt", tar(entries)))).toBe("type_mismatch")
    expect(code(() => inspect("code.tar.gz", tar(entries)))).toBe("type_mismatch")
  })

  it("refuses a gzip that inflates past the archive cap", () => {
    const bomb = gzipSync(new Uint8Array(110 * 1024 * 1024))
    expect(code(() => inspect("bomb.tar.gz", bomb))).toBe("unsafe_archive")
  })
})
