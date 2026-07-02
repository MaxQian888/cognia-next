import { enrichCandidate, type EnrichDeps } from "./enrich"
import type { CaptureCandidate } from "@/types/capture"

const urlCandidate: CaptureCandidate = {
  kind: "url",
  text: "https://x.test",
  sourceUrl: "https://x.test",
  fingerprint: "fp",
}
const imageCandidate: CaptureCandidate = {
  kind: "image",
  imageDataUrl: "data:image/png;base64,AAAA",
  fingerprint: "fp2",
}

describe("enrichCandidate", () => {
  it("reads a URL into markdown", async () => {
    const deps: EnrichDeps = { readUrl: async () => ({ markdown: "# Page", title: "Page" }) }
    const e = await enrichCandidate(urlCandidate, deps)
    expect(e).toEqual({ markdown: "# Page", title: "Page", via: "url-reader" })
  })

  it("OCRs an image into text", async () => {
    const deps: EnrichDeps = { ocrImage: async () => ({ text: "scanned text" }) }
    const e = await enrichCandidate(imageCandidate, deps)
    expect(e).toEqual({ markdown: "scanned text", via: "ocr" })
  })

  it("returns undefined when the reader yields nothing", async () => {
    const deps: EnrichDeps = { readUrl: async () => ({ markdown: "   " }) }
    expect(await enrichCandidate(urlCandidate, deps)).toBeUndefined()
  })

  it("swallows enricher errors", async () => {
    const deps: EnrichDeps = {
      readUrl: async () => {
        throw new Error("net")
      },
    }
    expect(await enrichCandidate(urlCandidate, deps)).toBeUndefined()
  })

  it("returns undefined for a text candidate", async () => {
    const c: CaptureCandidate = { kind: "text", text: "note", fingerprint: "fp3" }
    expect(await enrichCandidate(c, {})).toBeUndefined()
  })
})
