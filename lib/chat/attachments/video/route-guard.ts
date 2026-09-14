/**
 * The authoritative native-video check, run once the route is resolved.
 *
 * The composer decides native vs sampled from its best guess at the route —
 * the session's stored model and the app defaults. `resolveSendOptions` can
 * still land somewhere else: a model alias, a character's own model, a bot
 * default, the routing planner. A native `document` block sent to a route that
 * cannot take video is a 400 at best, so after resolution the controller passes
 * the content through here, and every native payload the resolved route cannot
 * accept is replaced — in place, manifest in lockstep — by the sampled payload
 * its manifest entry carries.
 */

import type { SendContent, SendContentBlock } from "@cognia/agent-config-types"
import type { AttachmentManifestEntry } from "../dispatch"
import {
  nativeVideoRouteVerdict,
  type NativeVideoBlockReason,
  type VideoRouteFacts,
} from "./delivery-gate"

export interface VideoRouteDowngrade {
  filename: string
  reason: NativeVideoBlockReason
}

export interface VideoRouteGuardResult {
  content: SendContent
  manifest: AttachmentManifestEntry[] | undefined
  /** Native videos replaced by their sampled payload. Empty when nothing changed. */
  downgraded: VideoRouteDowngrade[]
  /** Native video blocks removed because nothing described a fallback for them. */
  dropped: number
}

function isVideoDocument(block: SendContentBlock): boolean {
  return block.type === "document" && block.source.media_type.startsWith("video/")
}

export function enforceVideoDeliveryForRoute(
  content: SendContent,
  manifest: readonly AttachmentManifestEntry[] | undefined,
  facts: VideoRouteFacts
): VideoRouteGuardResult {
  const unchanged = {
    content,
    manifest: manifest ? [...manifest] : undefined,
    downgraded: [],
    dropped: 0,
  }
  if (typeof content === "string") return unchanged
  const verdict = nativeVideoRouteVerdict(facts)
  if (verdict.available) return unchanged

  const hasNative =
    content.some(isVideoDocument) ||
    (manifest ?? []).some((entry) => entry.video?.info.delivery === "native")
  if (!hasNative) return unchanged

  const nextContent: SendContentBlock[] = []
  const nextManifest: AttachmentManifestEntry[] = []
  const downgraded: VideoRouteDowngrade[] = []
  let dropped = 0
  const replaced = new Set<AttachmentManifestEntry>()

  content.forEach((block, index) => {
    const entry = manifest?.[index]
    const native = entry?.video?.info.delivery === "native" ? entry : undefined

    if (native) {
      if (replaced.has(native)) return
      replaced.add(native)
      const fallback = native.video!.fallback
      if (!fallback) {
        // Every block of this video is dropped; count the file itself once.
        dropped += 1
        return
      }
      const fallbackEntry: AttachmentManifestEntry = {
        filename: native.filename,
        mediaType: fallback.info.sourceMediaType,
        kind: "video",
        video: { info: fallback.info },
      }
      for (const fallbackBlock of fallback.blocks) {
        nextContent.push(fallbackBlock)
        nextManifest.push(fallbackEntry)
      }
      downgraded.push({ filename: native.filename, reason: verdict.reason })
      return
    }

    if (isVideoDocument(block)) {
      // A native video with no manifest to fall back through: never send it.
      dropped += 1
      return
    }

    nextContent.push(block)
    if (entry) nextManifest.push(entry)
  })

  return {
    content: nextContent,
    // The manifest only ever described a leading prefix of the blocks.
    manifest: manifest ? nextManifest : undefined,
    downgraded,
    dropped,
  }
}
