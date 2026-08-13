/** @jest-environment node */

import JSZip from "jszip"

import {
  buildCogniaPerfPackage,
  COGNIA_PERF_MAX_MANIFEST_BYTES,
  createPerfRawExportConfirmation,
  derivePerfProducerFingerprint,
  redactPerformanceValue,
  validateCogniaPerfPackage,
} from "./package-format"

const capture = {
  originalId: "capture-a",
  digest: "digest-a",
  wireVersion: 1,
  metricSchemaVersion: 1,
  sourceKind: "renderer" as const,
}

describe(".cognia-perf v1", () => {
  it("builds and validates one strictly hashed capture package", async () => {
    const bytes = await buildCogniaPerfPackage({
      capture,
      redactionMode: "redacted",
      producerFingerprint: "producer-a",
      issuedAt: "2026-08-13T00:00:00.000Z",
      entries: [
        {
          path: "summary.json",
          contentType: "application/json",
          bytes: new TextEncoder().encode("{}"),
        },
      ],
    })
    const validated = await validateCogniaPerfPackage(bytes)
    expect(validated.manifest.format).toBe("cognia-perf/v1")
    expect(validated.trustState).toBe("origin-unverified")
    expect(validated.entries.get("summary.json")).toEqual(new TextEncoder().encode("{}"))
  })

  it("signs canonical entry descriptors with P-256 and distinguishes trusted producers", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair
    const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey)
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
    const producerFingerprint = await derivePerfProducerFingerprint(publicJwk)
    const bytes = await buildCogniaPerfPackage({
      capture,
      redactionMode: "redacted",
      producerFingerprint,
      issuedAt: "2026-08-13T00:00:00.000Z",
      entries: [
        { path: "summary.json", contentType: "application/json", bytes: new Uint8Array([1]) },
      ],
      signingPrivateKeyJwk: privateJwk,
      signingPublicKeyJwk: publicJwk,
    })
    await expect(
      validateCogniaPerfPackage(bytes, new Set([producerFingerprint]))
    ).resolves.toMatchObject({ trustState: "verified" })
    await expect(validateCogniaPerfPackage(bytes)).resolves.toMatchObject({
      trustState: "valid-untrusted",
    })
  })

  it("rejects a signed package whose claimed producer is not the signing key", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair
    const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey)
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey)

    await expect(
      buildCogniaPerfPackage({
        capture,
        redactionMode: "redacted",
        producerFingerprint: "sha256:trusted-producer",
        issuedAt: "2026-08-13T00:00:00.000Z",
        entries: [
          { path: "summary.json", contentType: "application/json", bytes: new Uint8Array([1]) },
        ],
        signingPrivateKeyJwk: privateJwk,
        signingPublicKeyJwk: publicJwk,
      })
    ).rejects.toThrow("producer-key-mismatch")
  })

  it("binds capture provenance to the package signature", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair
    const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey)
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
    const producerFingerprint = await derivePerfProducerFingerprint(publicJwk)
    const bytes = await buildCogniaPerfPackage({
      capture,
      redactionMode: "redacted",
      producerFingerprint,
      issuedAt: "2026-08-13T00:00:00.000Z",
      entries: [
        { path: "summary.json", contentType: "application/json", bytes: new Uint8Array([1]) },
      ],
      signingPrivateKeyJwk: privateJwk,
      signingPublicKeyJwk: publicJwk,
    })
    const zip = await JSZip.loadAsync(bytes)
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"))
    manifest.capture.originalId = "tampered-origin"
    zip.file("manifest.json", JSON.stringify(manifest))

    await expect(
      validateCogniaPerfPackage(await zip.generateAsync({ type: "uint8array" }))
    ).rejects.toThrow("signature-invalid")
  })

  it("rejects an oversized manifest before inflating it", async () => {
    const zip = new JSZip()
    zip.file("manifest.json", " ".repeat(COGNIA_PERF_MAX_MANIFEST_BYTES + 1))
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })

    await expect(validateCogniaPerfPackage(bytes)).rejects.toThrow("manifest-too-large")
  })

  it("rejects duplicate descriptors, unsafe paths, unknown MIME types, and tampered bytes", async () => {
    await expect(
      buildCogniaPerfPackage({
        capture,
        redactionMode: "redacted",
        producerFingerprint: "producer-a",
        issuedAt: "2026-08-13T00:00:00.000Z",
        entries: [{ path: "../escape", contentType: "application/json", bytes: new Uint8Array() }],
      })
    ).rejects.toThrow("invalid-path")

    const bytes = await buildCogniaPerfPackage({
      capture,
      redactionMode: "redacted",
      producerFingerprint: "producer-a",
      issuedAt: "2026-08-13T00:00:00.000Z",
      entries: [
        { path: "summary.json", contentType: "application/json", bytes: new Uint8Array([1]) },
      ],
    })
    const zip = await JSZip.loadAsync(bytes)
    zip.file("summary.json", new Uint8Array([2]))
    const tampered = await zip.generateAsync({ type: "uint8array" })
    await expect(validateCogniaPerfPackage(tampered)).rejects.toThrow("integrity-failed")
  })

  it("requires a second confirmation bound to capture, manifest digest, and attachments for raw export", async () => {
    const expected = await createPerfRawExportConfirmation({
      captureIds: ["capture-a"],
      manifestDigest: "manifest-a",
      attachmentPaths: ["attachments/trace.bin"],
    })
    await expect(
      buildCogniaPerfPackage({
        capture,
        redactionMode: "raw",
        producerFingerprint: "producer-a",
        issuedAt: "2026-08-13T00:00:00.000Z",
        entries: [
          { path: "summary.json", contentType: "application/json", bytes: new Uint8Array([1]) },
        ],
        rawConfirmation: { expected, provided: "wrong" },
      })
    ).rejects.toThrow("raw-confirmation-required")
  })

  it("applies crash redaction plus stable structured pseudonyms", async () => {
    const redacted = await redactPerformanceValue(
      { name: "secret-process", detail: "token=abc@example.com" },
      "capture-a"
    )
    expect(redacted).toEqual({
      name: expect.stringMatching(/^perf_/),
      detail: expect.not.stringContaining("abc@example.com"),
    })
    expect(await redactPerformanceValue({ name: "secret-process" }, "capture-a")).toEqual(
      expect.objectContaining({ name: (redacted as { name: string }).name })
    )
  })
})
