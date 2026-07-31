/**
 * Lark media upload orchestration (TS side).
 *
 * Walks an outbound segment list, identifies any voice / video / file / image
 * segments whose `url` is still a remote HTTP(S) URL (not yet a Lark
 * `file_key` / `image_key`), and uploads each via the Rust-side Tauri
 * commands (`connectors_lark_upload_file` / `connectors_lark_upload_image`).
 * The returned segment list has the same shape, with each uploaded segment's
 * `url` replaced by the opaque key so the regular `card.ts` serializer can
 * emit the right Lark `msg_type` body.
 *
 * Why split this out from `card.ts`:
 *   - `card.ts` stays sync + pure (segments → message body)
 *   - Upload is async I/O; isolating it keeps the serializer testable without
 *     mocking the Tauri invoke surface
 *   - The pre-pass also lets the Lark adapter share a per-session `uploadCache`
 *     so repeated sends of the same URL don't re-upload
 */

import type { A2UISegmentContent, MessageSegment } from "@/types/connectors/segment"
import { walkA2UISurface } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import {
  connectorsLarkUploadFile,
  connectorsLarkUploadImage,
} from "@/lib/connectors/tauri/commands"

/** True when the segment carries a remote URL that still needs uploading. */
function needsUpload(url: string): boolean {
  return url.includes("://")
}

/** Lowercased extension of a URL's path (query/hash stripped), or "". */
function urlExtension(url: string): string {
  return url.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? ""
}

/**
 * Map a voice / video / file segment to a Lark `file_type` discriminator.
 * Lark accepts: opus, mp4, pdf, doc, xls, ppt, stream. Voice MUST be opus
 * (non-opus sources are degraded to plain files by the caller before this
 * runs); video defaults to mp4; file uses an extension-derived guess with
 * `stream` (binary catch-all) as the safe fallback.
 */
function guessFileType(segmentType: "voice" | "video" | "file", url: string): string {
  if (segmentType === "voice") return "opus"
  if (segmentType === "video") return "mp4"
  const ext = urlExtension(url)
  switch (ext) {
    case "pdf":
      return "pdf"
    case "doc":
    case "docx":
      return "doc"
    case "xls":
    case "xlsx":
      return "xls"
    case "ppt":
    case "pptx":
      return "ppt"
    case "mp4":
      return "mp4"
    case "opus":
      return "opus"
    default:
      return "stream"
  }
}

/** Generate a stable, safe file name from a URL (last path segment, or fallback). */
function fileNameFromUrl(url: string, fallback: string): string {
  try {
    const u = new URL(url)
    const last = u.pathname.split("/").filter(Boolean).pop()
    return last && last.length > 0 ? decodeURIComponent(last) : fallback
  } catch {
    return fallback
  }
}

export interface ResolveMediaKeysOptions {
  /** Resolves a fresh tenant access token (cached by `getTenantAccessToken`). */
  getAccessToken: () => Promise<string>
  /**
   * Optional per-adapter-session url→key cache. Pass the same Map across
   * multiple `send` calls on the same adapter and the helper will short-
   * circuit URLs it has already uploaded. Omitted in tests that don't care
   * about cross-call memoisation.
   */
  uploadCache?: Map<string, string>
  /** Override the Tauri uploaders (used by tests). */
  uploadFile?: typeof connectorsLarkUploadFile
  uploadImage?: typeof connectorsLarkUploadImage
}

/**
 * Walk `segments` and upload any voice/video/file/image segment whose `url`
 * is still a remote URL. Returns a new array with resolved keys; segments
 * that already carry a key (no `://`), and non-media segments, pass through
 * unchanged.
 *
 * Failures bubble up — the adapter's `send` classifies them into an
 * `OutboundError` (network / platform_*) so the outbound runner can retry
 * or deadletter cleanly. We never silently drop a segment.
 */
export async function resolveLarkMediaKeys(
  segments: MessageSegment[],
  opts: ResolveMediaKeysOptions
): Promise<MessageSegment[]> {
  const uploadFile = opts.uploadFile ?? connectorsLarkUploadFile
  const uploadImage = opts.uploadImage ?? connectorsLarkUploadImage
  const cache = opts.uploadCache

  let cachedToken: string | null = null
  const token = async () => {
    if (cachedToken === null) cachedToken = await opts.getAccessToken()
    return cachedToken
  }

  const out: MessageSegment[] = []
  for (const seg of segments) {
    // Voice degrade pre-pass: Lark's audio message (msg_type=audio) plays
    // ONLY opus. Uploading an mp3/m4a/wav with file_type=opus succeeds but
    // produces an unplayable voice bubble, so non-opus sources are degraded
    // to a regular file attachment instead (audible after download, never
    // broken). Remote URLs without an extension are assumed non-opus.
    if (seg.type === "voice" && needsUpload(seg.url) && urlExtension(seg.url) !== "opus") {
      const fileName = fileNameFromUrl(seg.url, "voice")
      const cachedKey = cache?.get(seg.url)
      const key =
        cachedKey ??
        (await uploadFile({
          accessToken: await token(),
          sourceUrl: seg.url,
          fileType: guessFileType("file", seg.url),
          fileName,
          durationMs: undefined,
        }))
      cache?.set(seg.url, key)
      out.push({
        type: "file",
        url: key,
        name: fileName,
        mimeType: seg.mimeType ?? "application/octet-stream",
        sizeBytes: 0,
      })
      continue
    }

    if (seg.type === "voice" || seg.type === "video" || seg.type === "file") {
      if (!needsUpload(seg.url)) {
        out.push(seg)
        continue
      }
      const cached = cache?.get(seg.url)
      if (cached) {
        out.push({ ...seg, url: cached })
        continue
      }
      const fileType = guessFileType(seg.type, seg.url)
      const fileName = seg.type === "file" ? seg.name : fileNameFromUrl(seg.url, seg.type)
      const durationMs =
        seg.type === "voice" && seg.durationSec !== undefined
          ? Math.round(seg.durationSec * 1000)
          : undefined
      const key = await uploadFile({
        accessToken: await token(),
        sourceUrl: seg.url,
        fileType,
        fileName,
        durationMs,
      })
      cache?.set(seg.url, key)
      out.push({ ...seg, url: key })
      continue
    }

    if (seg.type === "image") {
      if (!needsUpload(seg.url)) {
        out.push(seg)
        continue
      }
      const cached = cache?.get(seg.url)
      if (cached) {
        out.push({ ...seg, url: cached })
        continue
      }
      const key = await uploadImage({
        accessToken: await token(),
        sourceUrl: seg.url,
      })
      cache?.set(seg.url, key)
      out.push({ ...seg, url: key })
      continue
    }

    if (seg.type === "a2ui") {
      // A2UI Image nodes with a remote src degrade to a markdown link in
      // `card.ts` (Lark `img` elements only accept an uploaded image_key).
      // Upload each remote image here so the card renders a real `img`.
      // Per-URL failures degrade to today's link fallback instead of
      // failing the whole card — a broken CDN image must not kill an
      // otherwise deliverable interactive card.
      const remoteUrls = collectA2UIRemoteImageUrls(seg.content)
      if (remoteUrls.length === 0) {
        out.push(seg)
        continue
      }
      const mapping = new Map<string, string>()
      for (const url of remoteUrls) {
        const cached = cache?.get(url)
        if (cached) {
          mapping.set(url, cached)
          continue
        }
        try {
          const key = await uploadImage({ accessToken: await token(), sourceUrl: url })
          cache?.set(url, key)
          mapping.set(url, key)
        } catch {
          // Leave the URL in place — card.ts renders it as a link.
        }
      }
      out.push(
        mapping.size > 0 ? { ...seg, content: replaceA2UIImageUrls(seg.content, mapping) } : seg
      )
      continue
    }

    out.push(seg)
  }
  return out
}

/** Collect every remote (http/https) Image `src`/`url` inside a surface. */
export function collectA2UIRemoteImageUrls(surface: A2UISegmentContent): string[] {
  const urls = new Set<string>()
  walkA2UISurface(surface, (node) => {
    if (node.component !== "Image") return
    const src = node.raw.src ?? node.raw.url
    if (typeof src === "string" && needsUpload(src)) urls.add(src)
  })
  return [...urls]
}

/**
 * Return a deep-cloned surface whose Image nodes have their remote
 * `src`/`url` swapped for the uploaded image_key. The original surface is
 * never mutated — outbound requests are persisted rows and a retry must
 * re-serialize from the same source of truth.
 */
export function replaceA2UIImageUrls(
  surface: A2UISegmentContent,
  mapping: Map<string, string>
): A2UISegmentContent {
  const clone = structuredClone(surface)
  walkA2UISurface(clone, (node) => {
    if (node.component !== "Image") return
    for (const field of ["src", "url"] as const) {
      const value = node.raw[field]
      if (typeof value === "string") {
        const key = mapping.get(value)
        if (key) node.raw[field] = key
      }
    }
  })
  return clone
}
