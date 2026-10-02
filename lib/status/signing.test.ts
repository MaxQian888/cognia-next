import { SIGNATURE_WINDOW_MS } from "./contract"
import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalProbeSigningInput,
  isCanonicalSignedPath,
  PROBE_HEADERS,
  sha256Hex,
  signProbeRequest,
  verifyProbeRequest,
} from "./signing"

const encoder = new TextEncoder()
const SECRET = new Uint8Array(32).map((_, index) => index + 1)
const OTHER_SECRET = new Uint8Array(32).map((_, index) => 255 - index)
const PATH = "/api/status/v1/observations"
const NOW = 1_790_000_000_000

function headerBag(record: Record<string, string>) {
  return { get: (name: string) => record[name.toLowerCase()] ?? null }
}

async function signed(body = '{"a":1}', overrides: Partial<{ path: string; nowMs: number }> = {}) {
  const bytes = encoder.encode(body)
  const headers = await signProbeRequest({
    keyId: "key-1",
    secret: SECRET,
    method: "post",
    path: overrides.path ?? PATH,
    runId: "run_1",
    body: bytes,
    nowMs: overrides.nowMs ?? NOW,
  })
  return { bytes, headers }
}

function verify(
  headers: Record<string, string>,
  body: Uint8Array,
  opts: Partial<{ nowMs: number; path: string; method: string; secret: Uint8Array | null }> = {}
) {
  return verifyProbeRequest({
    headers: headerBag(headers),
    method: opts.method ?? "POST",
    path: opts.path ?? PATH,
    body,
    nowMs: opts.nowMs ?? NOW,
    resolveSecret: (keyId) =>
      keyId === "key-1" ? (opts.secret === undefined ? SECRET : opts.secret) : null,
  })
}

describe("probe request signing", () => {
  it("builds the documented canonical input", async () => {
    const digest = await sha256Hex(encoder.encode(""))
    expect(digest).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(
      canonicalProbeSigningInput({
        method: "post",
        path: PATH,
        timestampMs: 5,
        runId: "r",
        bodySha256Hex: digest,
      })
    ).toBe(`cognia-status-probe-v1\nPOST\n${PATH}\n5\nr\n${digest}`)
  })

  it("rejects ambiguous paths", () => {
    expect(isCanonicalSignedPath(PATH)).toBe(true)
    for (const path of [
      "relative",
      `${PATH}?probe=other`,
      `${PATH}#x`,
      "/api//status",
      "/api/./status",
      "/api/../admin",
      "/api/%2e%2e/admin",
      "/api\\admin",
    ]) {
      expect(isCanonicalSignedPath(path)).toBe(false)
    }
  })

  it("round-trips a valid signature", async () => {
    const { bytes, headers } = await signed()
    expect(headers[PROBE_HEADERS.keyId]).toBe("key-1")
    await expect(verify(headers, bytes)).resolves.toEqual({
      ok: true,
      keyId: "key-1",
      runId: "run_1",
      timestampMs: NOW,
    })
  })

  it("rejects a tampered body, path, method or run id", async () => {
    const { bytes, headers } = await signed()
    await expect(verify(headers, encoder.encode('{"a":2}'))).resolves.toMatchObject({
      ok: false,
      reason: "bad_signature",
    })
    await expect(
      verify(headers, bytes, { path: "/api/status/v1/admin/incidents" })
    ).resolves.toMatchObject({ ok: false, reason: "bad_signature" })
    await expect(verify(headers, bytes, { method: "PUT" })).resolves.toMatchObject({ ok: false })
    await expect(
      verify({ ...headers, [PROBE_HEADERS.runId]: "run_2" }, bytes)
    ).resolves.toMatchObject({ ok: false, reason: "bad_signature" })
  })

  it("rejects the wrong key and unknown key ids", async () => {
    const { bytes, headers } = await signed()
    await expect(verify(headers, bytes, { secret: OTHER_SECRET })).resolves.toMatchObject({
      ok: false,
      reason: "bad_signature",
    })
    await expect(
      verify({ ...headers, [PROBE_HEADERS.keyId]: "key-2" }, bytes)
    ).resolves.toMatchObject({ ok: false, reason: "unknown_key" })
  })

  it("enforces the timestamp window", async () => {
    const { bytes, headers } = await signed()
    await expect(
      verify(headers, bytes, { nowMs: NOW + SIGNATURE_WINDOW_MS + 1 })
    ).resolves.toMatchObject({ ok: false, reason: "outside_window" })
    await expect(
      verify(headers, bytes, { nowMs: NOW - SIGNATURE_WINDOW_MS - 1 })
    ).resolves.toMatchObject({ ok: false, reason: "outside_window" })
    await expect(
      verify(headers, bytes, { nowMs: NOW + SIGNATURE_WINDOW_MS })
    ).resolves.toMatchObject({ ok: true })
  })

  it("reports missing headers and malformed timestamps", async () => {
    const { bytes, headers } = await signed()
    const { [PROBE_HEADERS.signature]: _omit, ...withoutSignature } = headers
    await expect(verify(withoutSignature, bytes)).resolves.toMatchObject({
      ok: false,
      reason: "missing_header",
    })
    await expect(
      verify({ ...headers, [PROBE_HEADERS.timestamp]: "1e12" }, bytes)
    ).resolves.toMatchObject({ ok: false, reason: "bad_timestamp" })
  })

  it("refuses short secrets", async () => {
    await expect(
      signProbeRequest({
        keyId: "k",
        secret: new Uint8Array(16),
        method: "POST",
        path: PATH,
        runId: "r",
        body: new Uint8Array(),
        nowMs: NOW,
      })
    ).rejects.toThrow("probe secret too short")
  })

  it("encodes base64url without padding and decodes it back", () => {
    const bytes = new Uint8Array([251, 255, 0, 1])
    const encoded = bytesToBase64Url(bytes)
    expect(encoded).toBe("-_8AAQ")
    expect(Array.from(base64UrlToBytes(encoded) ?? [])).toEqual([251, 255, 0, 1])
    expect(base64UrlToBytes("not+base64")).toBeNull()
  })
})
