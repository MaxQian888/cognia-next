import { sha256Bytes } from "@/lib/ocr/hash"
import { encodeBase64 } from "@/lib/share/encoding"

import {
  assertNoUndeclaredFiles,
  loadJSZip,
  openHardenedZip,
  readDeclaredFile,
  verifyEd25519PackageSignature,
  writeDeterministicZip,
  type ArchiveLimits,
} from "./signed-zip"

const LIMITS: ArchiveLimits = {
  maxCompressedBytes: 1024 * 1024,
  maxExpandedBytes: 4 * 1024 * 1024,
  maxFiles: 16,
  maxCompressionRatio: 200,
  maxPathDepth: 8,
}

const text = (value: string) => new TextEncoder().encode(value)

describe("writeDeterministicZip", () => {
  it("produces identical bytes for identical entries", async () => {
    const entries = [
      { path: "a.txt", data: "alpha" },
      { path: "dir/b.bin", data: new Uint8Array([1, 2, 3]) },
    ]
    const first = await writeDeterministicZip(entries, LIMITS, "Cogpack")
    const second = await writeDeterministicZip(entries, LIMITS, "Cogpack")
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true)
  })

  it("refuses output over the compressed limit", async () => {
    await expect(
      writeDeterministicZip([{ path: "a", data: "x" }], { maxCompressedBytes: 10 }, "Cogpack")
    ).rejects.toThrow("Cogpack exceeds 10 compressed bytes")
  })
})

describe("openHardenedZip / readDeclaredFile", () => {
  async function pack(files: Record<string, string>): Promise<Uint8Array> {
    return writeDeterministicZip(
      Object.entries(files).map(([path, data]) => ({ path, data })),
      LIMITS,
      "Cogpack"
    )
  }

  it("reads a declared file and checks its hash", async () => {
    const archive = await openHardenedZip(await pack({ "a.txt": "alpha" }), LIMITS, "Cogpack")
    const known = new Set<string>()
    const read = await readDeclaredFile(
      archive,
      { path: "a.txt", sha256: await sha256Bytes(text("alpha")) },
      known,
      LIMITS,
      "Cogpack",
      "file"
    )
    expect(new TextDecoder().decode(read.bytes)).toBe("alpha")
    expect(() => assertNoUndeclaredFiles(archive, known, "Cogpack")).not.toThrow()
  })

  it("refuses a checksum mismatch, a missing file and a duplicate path", async () => {
    const archive = await openHardenedZip(await pack({ "a.txt": "alpha" }), LIMITS, "Cogpack")
    const known = new Set<string>()
    await expect(
      readDeclaredFile(archive, { path: "a.txt", sha256: "00" }, known, LIMITS, "Cogpack", "file")
    ).rejects.toThrow("Cogpack file checksum mismatch: a.txt")
    await expect(
      readDeclaredFile(archive, { path: "a.txt", sha256: "00" }, known, LIMITS, "Cogpack", "file")
    ).rejects.toThrow("Cogpack has duplicate path a.txt")
    await expect(
      readDeclaredFile(
        archive,
        { path: "b.txt", sha256: "00" },
        new Set(),
        LIMITS,
        "Cogpack",
        "file"
      )
    ).rejects.toThrow("Cogpack file is missing: b.txt")
  })

  it("refuses undeclared entries", async () => {
    const archive = await openHardenedZip(
      await pack({ "a.txt": "alpha", "extra.txt": "x" }),
      LIMITS,
      "Cogpack"
    )
    expect(() => assertNoUndeclaredFiles(archive, new Set(["a.txt"]), "Cogpack")).toThrow(
      "Cogpack contains undeclared path extra.txt"
    )
  })

  it("refuses too many files and unsafe expansion", async () => {
    await expect(
      openHardenedZip(await pack({ a: "1", b: "2" }), { ...LIMITS, maxFiles: 1 }, "Cogpack")
    ).rejects.toThrow("Cogpack exceeds 1 files")
    const bomb = await pack({ big: "0".repeat(100_000) })
    await expect(
      openHardenedZip(bomb, { ...LIMITS, maxCompressionRatio: 5 }, "Cogpack")
    ).rejects.toThrow("Cogpack file has unsafe archive expansion: big")
  })

  it("refuses an entry whose stored name escapes the root", async () => {
    const JSZip = await loadJSZip()
    const zip = new JSZip()
    zip.file("../evil.txt", "x")
    const bytes = await zip.generateAsync({ type: "uint8array" })
    await expect(openHardenedZip(bytes, LIMITS, "Cogpack")).rejects.toThrow(/Cogpack path/)
  })

  it("reports an unreadable archive with the label", async () => {
    await expect(openHardenedZip(text("not a zip"), LIMITS, "Cogpack")).rejects.toThrow(
      "Failed to read cogpack"
    )
  })
})

describe("verifyEd25519PackageSignature", () => {
  async function signed(payload: Uint8Array) {
    const keys = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))
    const signature = new Uint8Array(
      await crypto.subtle.sign("Ed25519", keys.privateKey, Uint8Array.from(payload))
    )
    return {
      algorithm: "ed25519" as const,
      publisher: "Tester",
      publicKey: encodeBase64(raw),
      signature: encodeBase64(signature),
    }
  }

  it("accepts a valid signature and refuses a tampered payload", async () => {
    const signature = await signed(text("manifest"))
    await expect(
      verifyEd25519PackageSignature(signature, text("manifest"), "Cogpack")
    ).resolves.toBeUndefined()
    await expect(
      verifyEd25519PackageSignature(signature, text("tampered"), "Cogpack")
    ).rejects.toThrow("Cogpack signature verification failed")
  })

  it("refuses a malformed key or signature", async () => {
    await expect(
      verifyEd25519PackageSignature(
        { algorithm: "ed25519", publisher: "x", publicKey: "AAAA", signature: "AAAA" },
        text("m"),
        "Cogpack"
      )
    ).rejects.toThrow("Cogpack Ed25519 signature shape is invalid")
    await expect(
      verifyEd25519PackageSignature(
        { algorithm: "ed25519", publisher: "x", publicKey: "%%%", signature: "AAAA" },
        text("m"),
        "Cogpack"
      )
    ).rejects.toThrow("Cogpack signature encoding is invalid")
  })
})
