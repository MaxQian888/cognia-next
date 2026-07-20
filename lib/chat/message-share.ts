import type { UIMessage } from "ai"

import { decodeDataUrl } from "@/lib/ocr/image-prep"
import { renderSafeInlineMarkdown } from "@/lib/export/html/safe-inline-markdown"

export interface MessageShareContent {
  plainText: string
  nativeShareText: string
  html: string
  shareFiles: File[]
  hasContent: boolean
}

/** Copy rich message content when supported, with a plain-text fallback. */
export async function writeMessageToClipboard(content: MessageShareContent): Promise<boolean> {
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined
  if (!clipboard) return false

  if (typeof clipboard.write === "function" && typeof ClipboardItem !== "undefined") {
    try {
      await clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([content.plainText], { type: "text/plain" }),
          "text/html": new Blob([content.html], { type: "text/html" }),
        }),
      ])
      return true
    } catch {
      // Some WebViews expose Clipboard.write but reject text/html. Continue
      // through the portable text path instead of surfacing a false success.
    }
  }

  if (typeof clipboard.writeText !== "function") return false
  try {
    await clipboard.writeText(content.plainText)
    return true
  } catch {
    return false
  }
}

interface FilePart {
  type: "file"
  url?: string
  mediaType?: string
  filename?: string
}

interface SourceUrlPart {
  type: "source-url"
  url: string
  title?: string
}

interface SourceDocumentPart {
  type: "source-document"
  title?: string
  mediaType?: string
}

/** Build one ordered, portable projection for message copy and native sharing. */
export function buildMessageShareContent(message: UIMessage): MessageShareContent {
  const plainParts: string[] = []
  const nativeShareParts: string[] = []
  const htmlParts: string[] = []
  const shareFiles: File[] = []
  let imageIndex = 0

  for (const part of message.parts) {
    if (part.type === "text") {
      const text = (part as { text?: string }).text ?? ""
      if (text) {
        plainParts.push(text)
        nativeShareParts.push(text)
        htmlParts.push(
          `<div>${renderSafeInlineMarkdown(escapeHtml(text)).replace(/\n/g, "<br>")}</div>`
        )
      }
      continue
    }

    if (part.type === "file") {
      const file = part as FilePart
      const label = file.filename || file.mediaType || "file"
      const isImage = Boolean(file.mediaType?.startsWith("image/"))
      if (file.url) {
        const markdownPart = isImage
          ? `![${escapeMarkdownLabel(label)}](${file.url})`
          : `[${escapeMarkdownLabel(label)}](${file.url})`
        plainParts.push(markdownPart)
        nativeShareParts.push(isImage && file.url.startsWith("data:image/") ? label : markdownPart)
        if (isSafeShareUrl(file.url, isImage)) {
          htmlParts.push(
            isImage
              ? `<figure><img src="${escapeHtml(file.url)}" alt="${escapeHtml(label)}"><figcaption>${escapeHtml(label)}</figcaption></figure>`
              : `<p><a href="${escapeHtml(file.url)}">${escapeHtml(label)}</a></p>`
          )
        } else {
          htmlParts.push(`<p>${escapeHtml(label)}</p>`)
        }

        if (isImage) {
          const decoded = tryDecodeDataUrl(file.url)
          if (decoded && typeof File !== "undefined") {
            imageIndex += 1
            shareFiles.push(
              new File(
                [decoded.bytes as BlobPart],
                imageFilename(file.filename, decoded.mimeType, imageIndex),
                {
                  type: decoded.mimeType,
                }
              )
            )
          }
        }
      } else {
        plainParts.push(label)
        nativeShareParts.push(label)
        htmlParts.push(`<p>${escapeHtml(label)}</p>`)
      }
      continue
    }

    if (part.type === "source-url") {
      const source = part as SourceUrlPart
      const label = source.title || source.url
      plainParts.push(`[${escapeMarkdownLabel(label)}](${source.url})`)
      nativeShareParts.push(`[${escapeMarkdownLabel(label)}](${source.url})`)
      htmlParts.push(
        isSafeShareUrl(source.url, false)
          ? `<p><a href="${escapeHtml(source.url)}">${escapeHtml(label)}</a></p>`
          : `<p>${escapeHtml(label)}</p>`
      )
      continue
    }

    if (part.type === "source-document") {
      const source = part as SourceDocumentPart
      const label = source.title || source.mediaType || "source"
      plainParts.push(label)
      nativeShareParts.push(label)
      htmlParts.push(`<p>${escapeHtml(label)}</p>`)
    }
  }

  const plainText = plainParts.join("\n\n")
  return {
    plainText,
    nativeShareText: nativeShareParts.join("\n\n"),
    html: htmlParts.join("\n"),
    shareFiles,
    hasContent: plainParts.length > 0,
  }
}

function tryDecodeDataUrl(url: string): ReturnType<typeof decodeDataUrl> {
  try {
    return decodeDataUrl(url)
  } catch {
    return null
  }
}

function imageFilename(filename: string | undefined, mediaType: string, index: number): string {
  if (filename?.trim()) return filename
  const extension = mediaType.split("/")[1]?.replace(/[^a-z0-9.+-]/gi, "") || "img"
  return `image-${index}.${extension}`
}

function isSafeShareUrl(url: string, image: boolean): boolean {
  const lower = url.trim().toLowerCase()
  if (/^(https?:|mailto:|blob:)/.test(lower) || lower.startsWith("/") || lower.startsWith("#")) {
    return true
  }
  return image && lower.startsWith("data:image/")
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\\[\]])/g, "\\$1")
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
