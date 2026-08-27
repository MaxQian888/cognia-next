/**
 * Composer attachment payloads and the conversions every host needs.
 *
 * Split out of `composer-plus-menu.tsx` because these are PURE functions with
 * no React and no store behind them, and the desktop composer's attachment
 * intake hook consumes them. Left in the menu module they dragged the whole
 * mobile sheet — and, once the sheet grew a plan-mode row, the chat store and
 * the execution broker — into the module graph of a hook that only ever wanted
 * `attachmentToFiles`.
 */

import type { SendContentBlock } from "@cognia/agent-config-types"

/** What a plus-menu branch produces. Not yet a `File` or a send block. */
export type ComposerAttachment =
  | { kind: "photo"; base64?: string; uri?: string; mime: string }
  | { kind: "photos"; items: Array<{ uri: string; mime: string }> }
  | { kind: "file"; file: File }
  | { kind: "files"; files: File[] }
  | { kind: "voice"; recordingDataUrl: string; mimeType: string; durationMs?: number }

// ---------------------------------------------------------------------------
// SendContent packing helpers (Mobile completeness Phase 2.5)
//
// `SendContent` already accepts an `image` block with inline base64
// (`{ type: "image", source: { type: "base64", data, media_type } }`), so
// no new RPC is required. These helpers translate the camera / album /
// file results into that shape so the chat composer can ship the image
// through `onSend`'s normal path (`claude_send` → SDK image block).
// ---------------------------------------------------------------------------

export function packPhotoAsSendContent(base64: string, mime: string): SendContentBlock[] {
  return [
    {
      type: "image",
      source: { type: "base64", media_type: mime, data: base64 },
    },
  ]
}

export async function packUriAsImageBlock(item: {
  uri: string
  mime: string
}): Promise<SendContentBlock | null> {
  if (typeof fetch !== "function") return null
  const response = await fetch(item.uri)
  const blob = await response.blob()
  const data = await blobToBase64(blob)
  if (!data) return null
  return {
    type: "image",
    source: { type: "base64", media_type: item.mime, data },
  }
}

export async function packFileAsImageBlock(file: File): Promise<SendContentBlock | null> {
  const data = await blobToBase64(file)
  if (!data) return null
  return {
    type: "image",
    source: { type: "base64", media_type: file.type || "image/jpeg", data },
  }
}

/**
 * Fold a plus-menu attachment into plain `File`s so hosts with a file-based
 * attachment pipeline (the shared chat composer's `acceptFiles`) can reuse
 * their existing size/count/type gates instead of growing a parallel path.
 * Voice payloads become an audio File; hosts that can't send audio should
 * hide the branch via `showVoice={false}` rather than dropping it here.
 */
export async function attachmentToFiles(attachment: ComposerAttachment): Promise<File[]> {
  switch (attachment.kind) {
    case "file":
      return [attachment.file]
    case "files":
      return attachment.files
    case "photo": {
      const source = attachment.base64
        ? `data:${attachment.mime};base64,${attachment.base64}`
        : attachment.uri
      if (!source) return []
      const blob = await (await fetch(source)).blob()
      const ext = attachment.mime.split("/")[1] ?? "jpeg"
      return [new File([blob], `photo-${Date.now()}.${ext}`, { type: attachment.mime })]
    }
    case "photos": {
      const files = await Promise.all(
        attachment.items.map(async (item, i) => {
          const blob = await (await fetch(item.uri)).blob()
          const ext = item.mime.split("/")[1] ?? "jpeg"
          return new File([blob], `photo-${Date.now()}-${i}.${ext}`, { type: item.mime })
        })
      )
      return files
    }
    case "voice": {
      const blob = await (await fetch(attachment.recordingDataUrl)).blob()
      const ext = attachment.mimeType.includes("aac") ? "aac" : "webm"
      return [new File([blob], `voice-${Date.now()}.${ext}`, { type: attachment.mimeType })]
    }
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : ""
      const base64 = url.includes(",") ? (url.split(",")[1] ?? "") : url
      resolve(base64)
    }
    reader.onerror = () => reject(reader.error ?? new Error("blob read failed"))
    reader.readAsDataURL(blob)
  })
}
