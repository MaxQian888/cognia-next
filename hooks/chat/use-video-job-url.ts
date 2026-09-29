"use client"

/**
 * A playable object URL for a finished video job's stored file (ADR-0205).
 *
 * Reads through `readRendererVideo`, the same reader the plugin API returns the
 * video with, so a session asset and a Files upload resolve one way. The URL is
 * revoked when the content changes or the caller unmounts.
 */

import { useEffect, useState } from "react"

import { readRendererVideo } from "@/lib/ai/media/video-jobs/renderer-host"
import type { VideoJobContent } from "@/lib/ai/media/video-jobs/types"

export type VideoJobUrlState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "missing" }

function keyOf(content: VideoJobContent | undefined): string | null {
  if (!content) return null
  switch (content.kind) {
    case "session-asset":
      return `session:${content.sessionId}:${content.assetId}`
    case "library":
      return `library:${content.assetId}`
    case "inline":
      return `inline:${content.bytes.byteLength}`
  }
}

export function useVideoJobUrl(content: VideoJobContent | undefined): VideoJobUrlState {
  const key = keyOf(content)
  const [state, setState] = useState<{ key: string | null; value: VideoJobUrlState }>({
    key: null,
    value: { status: "idle" },
  })

  useEffect(() => {
    if (!content || key === null) return
    let cancelled = false
    let url: string | null = null
    void readRendererVideo(content)
      .then((blob) => {
        if (cancelled) return
        url = URL.createObjectURL(blob)
        setState({ key, value: { status: "ready", url } })
      })
      .catch(() => {
        if (!cancelled) setState({ key, value: { status: "missing" } })
      })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
    // `key` identifies `content`; a new object with the same identity must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (key === null) return { status: "idle" }
  return state.key === key ? state.value : { status: "loading" }
}
