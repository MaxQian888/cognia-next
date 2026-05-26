// Builders that turn each shareable artifact into a SharePayload. Pure and
// app-side only (the viewer never imports this). `kind`/`mime`/`encoding` are
// what the viewer dispatches on after decryption.

import { encodeBase64 } from "./encoding"
import type { SharePayload, ShareKind } from "./types"
import type { SingleExportFormat } from "@/lib/export/single"

const FORMAT_KIND: Record<SingleExportFormat, ShareKind> = {
  markdown: "chat-md",
  json: "chat-json",
  text: "chat-text",
  html: "chat-html",
  animated: "chat-animated",
}

/** A rendered chat export (`renderSingleExport` output) → payload. */
export function chatExportPayload(
  rendered: { content: string; mimeType: string },
  format: SingleExportFormat,
  title: string
): SharePayload {
  return {
    kind: FORMAT_KIND[format],
    mime: rendered.mimeType,
    data: rendered.content,
    encoding: "utf8",
    title,
  }
}

/** A workflow PNG Blob → base64 payload. */
export async function workflowImagePayload(blob: Blob, title: string): Promise<SharePayload> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return {
    kind: "workflow-png",
    mime: blob.type || "image/png",
    data: encodeBase64(bytes),
    encoding: "base64",
    title,
  }
}

/** A serialized backup package (plaintext or already-encrypted JSON) → payload. */
export function backupPayload(serialized: string, title: string): SharePayload {
  return { kind: "backup", mime: "application/json", data: serialized, encoding: "utf8", title }
}

/** A serialized A2UI app (exportApp output) → payload. */
export function a2uiPayload(appJson: string, title: string): SharePayload {
  return { kind: "a2ui", mime: "application/json", data: appJson, encoding: "utf8", title }
}
