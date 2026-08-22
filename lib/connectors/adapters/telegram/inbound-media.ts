/**
 * Telegram's half of the shared inbound rich-media pass
 * (`_shared/inbound-media.ts` — see there for what the pass does and why).
 *
 * Telegram is the platform with no URL at all: `parse.ts` is pure, and the
 * protocol only carries a `file_id`, so a photo becomes
 * `{ type: "image", url: "tg://file/<file_id>" }`. Resolving it takes two
 * calls — `getFile` turns the id into a short-lived `file_path`, then the
 * bytes come from the `/file/bot<token>/` host.
 *
 * The cache is keyed on the STABLE `file_id`, never the path: the path expires
 * in about an hour while the id does not, so a redelivery or an album re-fetch
 * is a cache hit that never calls `getFile` at all.
 */

import {
  enrichInboundMedia,
  onceAsync,
  type EnrichableSegment,
  type InboundMediaDeps,
  type InboundMediaSource,
} from "@/lib/connectors/adapters/_shared/inbound-media"
import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

const TELEGRAM_API_BASE = "https://api.telegram.org"

/** The pseudo-URL scheme `parse.ts` emits for every media segment. */
export const TELEGRAM_FILE_SCHEME = "tg://file/"

export interface EnrichTelegramMediaDeps extends InboundMediaDeps {
  /** Resolve the bot token. Both calls need it — one in a path, one in a URL. */
  botToken: () => Promise<string>
  httpRequest?: typeof connectorsHttpRequest
}

/** `tg://file/<id>` → `<id>`, or `undefined` for anything else. */
export function fileIdFromUrl(url: string | undefined): string | undefined {
  if (!url || !url.startsWith(TELEGRAM_FILE_SCHEME)) return undefined
  const id = url.slice(TELEGRAM_FILE_SCHEME.length)
  return id.length > 0 ? id : undefined
}

/**
 * Guess a media type from the `file_path` Telegram returns.
 *
 * It matters: `inboundEventToSendContent` passes `mimeType` straight through as
 * the model's `media_type`, and Telegram photos are JPEG while the generic
 * fallback is PNG. A declared type that does not match the bytes is rejected by
 * the provider, so reading the real extension beats defaulting.
 */
export function mimeFromFilePath(filePath: string | undefined): string | undefined {
  const ext = filePath?.split(".").pop()?.toLowerCase()
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg"
    case "png":
      return "image/png"
    case "gif":
      return "image/gif"
    case "webp":
      return "image/webp"
    default:
      return undefined
  }
}

/**
 * `getFile` — resolve a `file_id` to the path under `/file/bot<token>/`.
 * Returns `undefined` for any non-ok response rather than throwing, because a
 * file that has aged out of Telegram's storage is an expected outcome.
 */
async function resolveFilePath(
  token: string,
  fileId: string,
  httpRequest: typeof connectorsHttpRequest
): Promise<string | undefined> {
  const resp = await httpRequest({
    url: `${TELEGRAM_API_BASE}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
    method: "GET",
  })
  if (resp.status < 200 || resp.status >= 300) return undefined
  const body = JSON.parse(resp.body) as { ok?: boolean; result?: { file_path?: string } }
  if (!body.ok) return undefined
  const filePath = body.result?.file_path
  return typeof filePath === "string" && filePath.length > 0 ? filePath : undefined
}

/** Enrich an inbound Telegram event's media segments in place. Never throws. */
export async function enrichTelegramInboundMedia(
  event: NormalizedInboundEvent,
  deps: EnrichTelegramMediaDeps
): Promise<void> {
  const httpRequest = deps.httpRequest ?? connectorsHttpRequest
  // One album shares one token; a locked keyring must cost one read, not ten.
  const token = onceAsync(deps.botToken)

  await enrichInboundMedia(
    event,
    {
      ref: (seg: EnrichableSegment) => {
        const fileId = fileIdFromUrl(seg.url)
        return fileId ? `telegram:${fileId}` : undefined
      },
      source: async (seg: EnrichableSegment): Promise<InboundMediaSource | undefined> => {
        const fileId = fileIdFromUrl(seg.url)
        if (!fileId) return undefined
        const resolved = await token()
        const filePath = await resolveFilePath(resolved, fileId, httpRequest)
        if (!filePath) return undefined
        return {
          url: `${TELEGRAM_API_BASE}/file/bot${resolved}/${filePath}`,
          mimeType: mimeFromFilePath(filePath),
        }
      },
      // Telegram photos are JPEG; the generic fallback is PNG.
      defaultImageMime: "image/jpeg",
      extractLabel: "telegram-inbound",
    },
    deps
  )
}
