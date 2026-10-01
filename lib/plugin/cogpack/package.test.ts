import { packageFormatErrorCode } from "@/lib/packaging/archive-path"
import { loadJSZip } from "@/lib/packaging/signed-zip"

import { encodeBase64 } from "@/lib/share/encoding"
import { cogpackSignaturePayload } from "./manifest"
import {
  exportCogpack,
  inspectCogpack,
  type CogpackSigner,
  type ExportCogpackInput,
} from "./package"

const text = (value: string) => new TextEncoder().encode(value)
const SHA = "0123456789abcdef0123456789abcdef01234567"

function input(overrides: Partial<ExportCogpackInput> = {}): ExportCogpackInput {
  return {
    id: "deep-writer",
    version: "1.0.0",
    name: "Deep writer",
    minHostVersion: "0.1.0",
    members: [
      {
        id: "local-notes",
        name: "Local notes",
        version: "0.2.0",
        optional: false,
        source: { kind: "embedded" },
        config: { folder: "notes" },
        secretFields: ["token"],
      },
      {
        id: "gh-tools",
        name: "GitHub tools",
        version: "1.0.0",
        optional: true,
        source: { kind: "github", owner: "acme", repo: "tools", commit: SHA },
      },
    ],
    embedded: new Map([
      [
        "local-notes",
        [
          { path: "plugin.json", bytes: text('{"id":"local-notes"}') },
          { path: "dist/index.js", bytes: text("export {}") },
        ],
      ],
    ]),
    ...overrides,
  }
}

async function signer(): Promise<CogpackSigner & { raw: Uint8Array }> {
  const keys = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))
  return {
    raw,
    publisher: "Ada",
    publicKey: encodeBase64(raw),
    sign: async (payload) =>
      new Uint8Array(
        await crypto.subtle.sign("Ed25519", keys.privateKey, Uint8Array.from(payload))
      ),
  }
}

describe("cogpack archive", () => {
  it("round-trips an unsigned cogpack with embedded files and references", async () => {
    const exported = await exportCogpack(input())
    expect(exported.manifest.members.map((m) => m.id)).toEqual(["gh-tools", "local-notes"])
    const inspected = await inspectCogpack(exported.bytes)
    expect(inspected.signed).toBe(false)
    expect(inspected.fingerprint).toBe(exported.fingerprint)
    expect(inspected.manifest).toEqual(exported.manifest)
    const files = inspected.embedded.get("local-notes")!
    expect([...files.keys()].sort()).toEqual(["dist/index.js", "plugin.json"])
    expect(new TextDecoder().decode(files.get("dist/index.js"))).toBe("export {}")
    expect(inspected.embedded.has("gh-tools")).toBe(false)
  })

  it("is deterministic", async () => {
    const a = await exportCogpack(input())
    const b = await exportCogpack(input())
    expect(a.fingerprint).toBe(b.fingerprint)
  })

  it("signs, verifies, and refuses a tampered manifest", async () => {
    const key = await signer()
    const exported = await exportCogpack(input({ signer: key }))
    expect(exported.manifest.signature).toMatchObject({
      publisher: "Ada",
      publicKey: key.publicKey,
    })
    const inspected = await inspectCogpack(exported.bytes)
    expect(inspected.signed).toBe(true)

    // Re-pack with one field changed but the old signature kept.
    const JSZip = await loadJSZip()
    const zip = await JSZip.loadAsync(exported.bytes)
    const tampered = { ...exported.manifest, name: "Something else" }
    zip.file("manifest.json", JSON.stringify(tampered))
    const bytes = await zip.generateAsync({ type: "uint8array" })
    await expect(inspectCogpack(bytes)).rejects.toThrow("Cogpack signature verification failed")
  })

  it("covers embedded files with the signature through their hashes", async () => {
    const exported = await exportCogpack(input({ signer: await signer() }))
    const JSZip = await loadJSZip()
    const zip = await JSZip.loadAsync(exported.bytes)
    zip.file("plugins/local-notes/dist/index.js", "evil()")
    const bytes = await zip.generateAsync({ type: "uint8array" })
    await expect(inspectCogpack(bytes)).rejects.toThrow("Cogpack file checksum mismatch")
  })

  it("refuses undeclared files and a missing manifest", async () => {
    const exported = await exportCogpack(input())
    const JSZip = await loadJSZip()
    const extra = await JSZip.loadAsync(exported.bytes)
    extra.file("plugins/local-notes/sneaky.js", "x")
    await expect(inspectCogpack(await extra.generateAsync({ type: "uint8array" }))).rejects.toThrow(
      "Cogpack contains undeclared path plugins/local-notes/sneaky.js"
    )
    const empty = new JSZip()
    empty.file("readme.txt", "hi")
    await expect(inspectCogpack(await empty.generateAsync({ type: "uint8array" }))).rejects.toThrow(
      "Cogpack manifest is missing"
    )
  })

  it("tags every refusal with a code the import dialog translates", async () => {
    const codeOf = (bytes: Uint8Array) =>
      inspectCogpack(bytes).then(
        () => "opened",
        (error: unknown) => packageFormatErrorCode(error)
      )
    const JSZip = await loadJSZip()
    const exported = await exportCogpack(input({ signer: await signer() }))

    expect(await codeOf(new Uint8Array([1, 2, 3]))).toBe("unreadable")

    const tamperedFile = await JSZip.loadAsync(exported.bytes)
    tamperedFile.file("plugins/local-notes/dist/index.js", "evil()")
    expect(await codeOf(await tamperedFile.generateAsync({ type: "uint8array" }))).toBe(
      "checksum-mismatch"
    )

    const tamperedManifest = await JSZip.loadAsync(exported.bytes)
    tamperedManifest.file("manifest.json", JSON.stringify({ ...exported.manifest, name: "Other" }))
    expect(await codeOf(await tamperedManifest.generateAsync({ type: "uint8array" }))).toBe(
      "signature-invalid"
    )

    const extra = await JSZip.loadAsync(exported.bytes)
    extra.file("plugins/local-notes/sneaky.js", "x")
    expect(await codeOf(await extra.generateAsync({ type: "uint8array" }))).toBe("undeclared-path")

    const notJson = new JSZip()
    notJson.file("manifest.json", "{")
    expect(await codeOf(await notJson.generateAsync({ type: "uint8array" }))).toBe(
      "manifest-not-json"
    )

    const malformed = new JSZip()
    malformed.file("manifest.json", JSON.stringify({ kind: "something-else" }))
    expect(await codeOf(await malformed.generateAsync({ type: "uint8array" }))).toBe(
      "manifest-invalid"
    )

    const missing = new JSZip()
    missing.file("readme.txt", "hi")
    expect(await codeOf(await missing.generateAsync({ type: "uint8array" }))).toBe(
      "manifest-missing"
    )
  })

  it("refuses an embedded member with no files at export", async () => {
    await expect(exportCogpack(input({ embedded: new Map() }))).rejects.toThrow(
      "member local-notes is embedded but has no files"
    )
  })

  it("the stored signature payload excludes the signature itself", async () => {
    const exported = await exportCogpack(input({ signer: await signer() }))
    const { signature: _s, ...unsigned } = exported.manifest
    expect(cogpackSignaturePayload(exported.manifest)).toEqual(
      cogpackSignaturePayload(unsigned as typeof exported.manifest)
    )
  })
})
