import nodeFs from "node:fs"
import nodeOs from "node:os"
import nodePath from "node:path"

import { resolvePdfRef } from "./pdf"

const fileDeps = (bytes: ArrayBuffer | null) => ({
  readFileBytes: () => {
    if (!bytes) throw new Error("ENOENT")
    return bytes
  },
  isFile: () => bytes != null,
})

const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer // %PDF

describe("resolvePdfRef", () => {
  it("emits a native document block for an Anthropic model", async () => {
    const r = await resolvePdfRef("spec.pdf", "/w", {
      isAnthropic: true,
      provider: "anthropic",
      model: "claude-opus-4-5",
      ...fileDeps(bytes),
    })
    expect(r.kind).toBe("block")
    if (r.kind === "block") {
      expect(r.block.type).toBe("document")
      expect(r.block.source.media_type).toBe("application/pdf")
    }
  })

  it("emits a native document block for a non-Anthropic PDF-capable model", async () => {
    const r = await resolvePdfRef("spec.pdf", "/w", {
      isAnthropic: false,
      provider: "google",
      model: "gemini-2.5-pro",
      ...fileDeps(bytes),
    })
    expect(r.kind).toBe("block")
  })

  it("falls back to OCR text for a non-capable model", async () => {
    const r = await resolvePdfRef("spec.pdf", "/w", {
      isAnthropic: false,
      provider: "acme",
      model: "acme-text-only-1",
      ...fileDeps(bytes),
      runOcr: async () => ({ ok: true, text: "# OCR'd" }),
    })
    expect(r).toEqual({ kind: "text", text: '<file path="spec.pdf">\n# OCR\'d\n</file>' })
  })

  it("reports failure when reading bytes throws on an existing file", async () => {
    const r = await resolvePdfRef("x.pdf", "/w", {
      isAnthropic: true,
      provider: "anthropic",
      model: "claude-opus-4-5",
      isFile: () => true,
      readFileBytes: () => {
        throw new Error("EIO")
      },
    })
    expect(r).toEqual({ kind: "failed" })
  })

  it("accepts an absolute ref without re-resolving against cwd", async () => {
    const r = await resolvePdfRef("/abs/x.pdf", "/w", {
      isAnthropic: true,
      provider: "anthropic",
      model: "claude-opus-4-5",
      isFile: () => true,
      readFileBytes: () => bytes,
    })
    expect(r.kind).toBe("block")
  })

  it("defaults the OCR key resolver to null when none is supplied", async () => {
    // No anthropicKey and no runOcr → default runOcr with the `() => null`
    // fallback key resolver → real OCR runner fails closed.
    const r = await resolvePdfRef("rel.pdf", "/w", {
      isAnthropic: false,
      provider: "acme",
      model: "acme-text-only-1",
      isFile: () => true,
      readFileBytes: () => bytes,
    })
    expect(r).toEqual({ kind: "failed", reason: "no-anthropic-key" })
  })

  it("reports failure when the file is missing", async () => {
    const r = await resolvePdfRef("missing.pdf", "/w", {
      isAnthropic: true,
      provider: "anthropic",
      model: "claude-opus-4-5",
      ...fileDeps(null),
    })
    expect(r).toEqual({ kind: "failed" })
  })

  it("reports the OCR reason when fallback OCR fails", async () => {
    const r = await resolvePdfRef("spec.pdf", "/w", {
      isAnthropic: false,
      provider: "acme",
      model: "acme-text-only-1",
      ...fileDeps(bytes),
      runOcr: async () => ({ ok: false, reason: "no-anthropic-key" }),
    })
    expect(r).toEqual({ kind: "failed", reason: "no-anthropic-key" })
  })

  // Default runOcr (no injection): the real OCR runner fails closed without an
  // Anthropic key, exercising the default fallback wiring without any network.
  it("uses the real OCR runner by default and fails closed without a key", async () => {
    const r = await resolvePdfRef("spec.pdf", "/w", {
      isAnthropic: false,
      provider: "acme",
      model: "acme-text-only-1",
      anthropicKey: () => null,
      ...fileDeps(bytes),
    })
    expect(r).toEqual({ kind: "failed", reason: "no-anthropic-key" })
  })

  it("reads real bytes for a native block and reports a real missing file (default fs)", async () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "pdf-"))
    try {
      nodeFs.writeFileSync(nodePath.join(dir, "d.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46]))
      const ok = await resolvePdfRef("d.pdf", dir, {
        isAnthropic: true,
        provider: "anthropic",
        model: "claude-opus-4-5",
      })
      expect(ok.kind).toBe("block")
      const miss = await resolvePdfRef("missing.pdf", dir, {
        isAnthropic: true,
        provider: "anthropic",
        model: "claude-opus-4-5",
      })
      expect(miss).toEqual({ kind: "failed" })
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
