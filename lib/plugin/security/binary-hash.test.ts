// Node env (the default for lib/**/*.test.ts) — deliberately NOT jsdom.
// `sha256Bytes` calls `crypto.subtle.digest`, and jest.setup.ts polyfills
// `globalThis.crypto` with Node's `webcrypto`. Under jsdom that polyfill is
// cross-realm: a jsdom-realm ArrayBuffer fails webcrypto's `instanceof
// ArrayBuffer` check and digest throws. That is an artifact of the polyfill,
// not a production defect — the Tauri/browser webview has a single realm and
// its own same-realm `crypto.subtle`. Running here in node keeps the
// known-answer vectors meaningful instead of asserting the harness's quirk.

const readBinaryFileMock = jest.fn<Promise<Uint8Array>, [string]>()

jest.mock("@/lib/file/file-operations", () => ({
  readBinaryFile: (path: string) => readBinaryFileMock(path),
}))

import { hashBinaryFile } from "./binary-hash"

// Known-answer test: SHA-256("abc") — pins that we hash the bytes themselves,
// not some wrapper, and that the output is lower-case hex.
const ABC_BYTES = new Uint8Array([0x61, 0x62, 0x63])
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

beforeEach(() => {
  readBinaryFileMock.mockReset()
})

describe("hashBinaryFile", () => {
  it("hashes the file's bytes and returns lower-case hex", async () => {
    readBinaryFileMock.mockResolvedValue(ABC_BYTES)
    await expect(hashBinaryFile("/plugins/p/bin/tool")).resolves.toBe(ABC_SHA256)
    expect(readBinaryFileMock).toHaveBeenCalledWith("/plugins/p/bin/tool")
  })

  it("returns a different hash for different bytes", async () => {
    readBinaryFileMock.mockResolvedValue(new Uint8Array([0x61, 0x62, 0x64]))
    const digest = await hashBinaryFile("/plugins/p/bin/tool")
    expect(digest).not.toBe(ABC_SHA256)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it("hashes an empty file to the well-known empty digest", async () => {
    readBinaryFileMock.mockResolvedValue(new Uint8Array([]))
    await expect(hashBinaryFile("/plugins/p/bin/empty")).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    )
  })

  it("returns null — never a hash — when the file cannot be read", async () => {
    // A binary we cannot read is exactly the one we must not spawn silently;
    // the policies treat null as "identity unproven" and prompt.
    readBinaryFileMock.mockRejectedValue(new Error("ENOENT: no such file"))
    await expect(hashBinaryFile("/plugins/p/bin/missing")).resolves.toBeNull()
  })

  it("returns null when the read resolves but hashing throws", async () => {
    readBinaryFileMock.mockResolvedValue(undefined as unknown as Uint8Array)
    await expect(hashBinaryFile("/plugins/p/bin/weird")).resolves.toBeNull()
  })
})
