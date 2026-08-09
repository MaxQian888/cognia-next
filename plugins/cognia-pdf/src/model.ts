import type { PdfInspection } from "./pdf-engine"

export const PDF_ARTIFACT_KIND = "cognia-pdf/document"
export const PDF_SCHEMA_VERSION = 1 as const
export const PDF_MIME = "application/pdf"

export interface PdfArtifactDocument {
  schemaVersion: typeof PDF_SCHEMA_VERSION
  title: string
  sourceFilename?: string
  dataBase64: string
  inspection: PdfInspection
  expectedValues: Record<string, string | string[] | boolean>
}

export function createPdfArtifactDocument(input: {
  title: string
  sourceFilename?: string
  bytes: Uint8Array
  inspection: PdfInspection
  expectedValues?: PdfArtifactDocument["expectedValues"]
}): PdfArtifactDocument {
  if (!input.title.trim()) throw new Error("PDF title is required.")
  return {
    schemaVersion: PDF_SCHEMA_VERSION,
    title: input.title.trim(),
    ...(input.sourceFilename ? { sourceFilename: input.sourceFilename } : {}),
    dataBase64: bytesToBase64(input.bytes),
    inspection: input.inspection,
    expectedValues: { ...(input.expectedValues ?? {}) },
  }
}

export function parsePdfArtifact(content: string): PdfArtifactDocument {
  const parsed = JSON.parse(content) as Partial<PdfArtifactDocument>
  if (parsed.schemaVersion !== PDF_SCHEMA_VERSION) {
    throw new Error(`Unsupported PDF artifact schema version: ${String(parsed.schemaVersion)}`)
  }
  if (!parsed.title?.trim() || !parsed.dataBase64 || !parsed.inspection) {
    throw new Error("Invalid Cognia PDF artifact payload.")
  }
  return parsed as PdfArtifactDocument
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64")
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

export function base64ToBytes(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"))
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
