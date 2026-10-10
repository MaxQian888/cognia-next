"use client"

/**
 * A Files image, resolved through the shared media cache. The grid asks for
 * the stored thumbnail; the preview asks for the canonical frame. Every
 * acquire is paired with a release so the object URL can be evicted.
 *
 * On a paired device the bytes are the host's: the page's backend hands a
 * loader for `entry` (`useFilesMediaLoader`), which the cache runs only when
 * its own store misses, so an image read once stays readable offline.
 */

import { useEffect, useState } from "react"
import { ImageOffIcon } from "lucide-react"

import { useFilesMediaLoader } from "@/hooks/files-library/files-backend"
import { acquireMedia, releaseMedia } from "@/lib/chat/media/resolve-media"
import { mediaRef } from "@/lib/db/message-media"
import type { FilesEntry } from "@/lib/files-library/types"
import { cn } from "@/lib/utils"

export interface FilesImageThumbProps {
  hash: string
  alt: string
  /** Canonical frame instead of the thumbnail. */
  full?: boolean
  /** The entry the image belongs to: where its bytes come from when not stored here. */
  entry?: FilesEntry
  className?: string
}

export function FilesImageThumb({
  hash,
  alt,
  full = false,
  entry,
  className,
}: FilesImageThumbProps) {
  const loadMissing = useFilesMediaLoader(entry)
  const [state, setState] = useState<{ hash: string; url: string | null; failed: boolean }>({
    hash,
    url: null,
    failed: false,
  })

  useEffect(() => {
    const ref = mediaRef(hash)
    const options = { thumbnail: !full }
    let cancelled = false
    let acquired = false
    void acquireMedia(ref, loadMissing ? { ...options, loadMissing } : options)
      .then((resolved) => {
        if (resolved) acquired = true
        if (cancelled) {
          if (acquired) releaseMedia(ref, options)
          return
        }
        setState({ hash, url: resolved?.url ?? null, failed: !resolved })
      })
      .catch(() => {
        if (!cancelled) setState({ hash, url: null, failed: true })
      })
    return () => {
      cancelled = true
      if (acquired) releaseMedia(ref, options)
    }
  }, [hash, full, loadMissing])

  const current = state.hash === hash ? state : { url: null, failed: false }
  if (current.failed) {
    return (
      <div
        className={cn("flex items-center justify-center bg-muted text-muted-foreground", className)}
        data-testid="files-image-missing"
      >
        <ImageOffIcon className="size-6" aria-hidden />
      </div>
    )
  }
  if (!current.url) {
    return (
      <div className={cn("animate-pulse bg-muted", className)} data-testid="files-image-loading" />
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- object URL from the media cache
    <img
      src={current.url}
      alt={alt}
      className={cn("object-cover", className)}
      draggable={false}
      data-testid="files-image"
    />
  )
}
