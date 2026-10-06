"use client"

/**
 * React bindings for the link preview store (ADR-0218).
 *
 * `useLinkPreview` drives a preview card: it fetches only while `enabled`
 * (the card is open, previews are on, the turn has stopped streaming) and only
 * on shells that can read cross-origin pages; everywhere else it reports
 * `local`, which the card renders from the URL alone.
 *
 * `usePreviewImage` turns a remote image URL into an `<img src>` this shell
 * can load, and remembers images that failed so a broken favicon is not
 * re-requested by every link that shares its host.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react"
import { canFetchLinkPreviews, type LinkPreview } from "@/lib/web/link-preview/fetch-preview"
import {
  loadLinkPreview,
  loadPreviewImage,
  markPreviewImageFailed,
  peekLinkPreview,
  peekPreviewImage,
  previewImageFailed,
  previewImagesNeedInlining,
  subscribeLinkPreview,
} from "@/lib/web/link-preview/preview-store"

export type LinkPreviewState =
  | { status: "local" }
  | { status: "loading" }
  | { status: "ready"; preview: LinkPreview }
  | { status: "error" }

const noopSubscribe = () => () => undefined

export function useLinkPreview(url: string | null, enabled: boolean): LinkPreviewState {
  const active = Boolean(url) && enabled && canFetchLinkPreviews()
  const key = active ? (url as string) : null

  const subscribe = useCallback(
    (listener: () => void) => (key ? subscribeLinkPreview(key, listener) : () => undefined),
    [key]
  )
  const entry = useSyncExternalStore(
    key ? subscribe : noopSubscribe,
    () => (key ? peekLinkPreview(key) : undefined),
    () => undefined
  )

  useEffect(() => {
    if (key && !peekLinkPreview(key)) void loadLinkPreview(key)
  }, [key])

  if (!key) return { status: "local" }
  if (!entry) return { status: "loading" }
  return entry.status === "ready"
    ? { status: "ready", preview: entry.preview }
    : { status: "error" }
}

export interface PreviewImageState {
  /** What to put in `src`, or null while unknown / when it cannot load. */
  src: string | null
  /** Hand to the `<img>`'s `onError` so a dead image is remembered. */
  onError: () => void
}

export function usePreviewImage(url: string | null | undefined, enabled = true): PreviewImageState {
  const key = url && enabled ? url : null
  const subscribe = useCallback(
    (listener: () => void) => (key ? subscribeLinkPreview(key, listener) : () => undefined),
    [key]
  )
  const src = useSyncExternalStore(
    key ? subscribe : noopSubscribe,
    () => (key && !previewImageFailed(key) ? peekPreviewImage(key) : null),
    () => null
  )

  useEffect(() => {
    if (key && previewImagesNeedInlining() && !peekPreviewImage(key) && !previewImageFailed(key)) {
      void loadPreviewImage(key)
    }
  }, [key])

  const onError = useCallback(() => {
    if (key) markPreviewImageFailed(key)
  }, [key])

  return { src, onError }
}
