import { base64ToBytes, bytesToBase64, createPdfArtifactDocument, parsePdfArtifact } from "./model"

const INSPECTION = {
  pageCount: 1,
  encrypted: false,
  signed: false,
  fields: [],
  metadata: {},
  warnings: [],
}

it("round-trips PDF bytes through the artifact model", () => {
  const bytes = Uint8Array.from([0, 1, 127, 255])
  expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
  expect(
    parsePdfArtifact(
      JSON.stringify(createPdfArtifactDocument({ title: "Form", bytes, inspection: INSPECTION }))
    )
  ).toMatchObject({ title: "Form", dataBase64: expect.any(String) })
})

it("rejects malformed artifact payloads and schema versions", () => {
  expect(() => parsePdfArtifact(JSON.stringify({ schemaVersion: 2 }))).toThrow("schema version")
  expect(() =>
    parsePdfArtifact(JSON.stringify({ schemaVersion: 1, title: "", dataBase64: "AA==" }))
  ).toThrow("Invalid Cognia PDF")
  expect(() =>
    parsePdfArtifact(JSON.stringify({ schemaVersion: 1, title: "x", dataBase64: "AA==" }))
  ).toThrow("Invalid Cognia PDF")
})

it("requires a non-blank title", () => {
  expect(() =>
    createPdfArtifactDocument({ title: "  ", bytes: Uint8Array.from([1]), inspection: INSPECTION })
  ).toThrow("title is required")
})

it("falls back to btoa/atob when Buffer is unavailable (browser shell)", () => {
  const originalBuffer = globalThis.Buffer
  try {
    // @ts-expect-error simulate the browser bundle where Buffer is not a global
    globalThis.Buffer = undefined
    const bytes = Uint8Array.from([0, 1, 127, 255, 33])
    const encoded = bytesToBase64(bytes)
    expect(encoded).toBe(btoa(String.fromCharCode(...bytes)))
    expect(base64ToBytes(encoded)).toEqual(bytes)
  } finally {
    globalThis.Buffer = originalBuffer
  }
})
