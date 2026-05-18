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

import type { MessageSegment } from "@/types/connectors/segment"
import {
  connectorsLarkUploadFile,
  connectorsLarkUploadImage,
} from "@/lib/connectors/tauri/commands"

/** True when the segment carries a remote URL that still needs uploading. */
function needsUpload(url: string): boolean {
  return url.includes("://")
}

/**
 * Map a voice / video / file segment to a Lark `file_type` discriminator.
 * Lark accepts: opus, mp4, pdf, doc, xls, ppt, stream. Voice MUST be opus;
 * video defaults to mp4; file uses an extension-derived guess with `stream`
 * (binary catch-all) as the safe fallback.
 */
function guessFileType(segmentType: "voice" | "video" | "file", url: string): string {
  if (segmentType === "voice") return "opus"
  if (segmentType === "video") return "mp4"
  const ext = url.split(/[?#]/)[0].split(".").pop()?.toLowerCase()
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
 * Failures bubble up — the adapter's `send` translates them into a
 * `platform_5xx` `OutboundError` so the outbound runner can deadletter
 * cleanly. We never silently drop a segment.
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

    out.push(seg)
  }
  return out
}
