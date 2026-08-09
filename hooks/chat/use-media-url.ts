"use client"

import { useCallback, useEffect, useState } from "react"

import { isMediaRef } from "@/lib/db/message-media"
import {
  acquireMedia,
  releaseMedia,
  type AcquireOptions,
  type ResolvedMedia,
} from "@/lib/chat/media/resolve-media"
import { useSessionMediaLoader } from "./session-media-provider"

export type MediaUrlStatus = "inactive" | "loading" | "ready" | "missing"

export interface MediaUrlState {
  /** Object URL to render, or null while loading / when the reference is dead. */
  url: string | null
  /** Intrinsic size of the resolved image; 0 until it is known. */
  width: number
  height: number
  isThumbnail: boolean
  status: MediaUrlStatus
  /** Retry a failed local resolve or remote session-media request. */
  retry: () => void
}

const BASE_STATE = {
  url: null,
  width: 0,
  height: 0,
  isThumbnail: false,
}

/** What the effect has settled on, tagged with the ref it settled for. */
interface Settled {
  ref: string
  thumbnail: boolean
  state: MediaUrlState
}

/**
 * Hold a `cognia-media:` reference for as long as this component is mounted.
 *
 * Acquire/release is the whole point: the registry cannot revoke an object URL
 * while an `<img>` still points at it, and it cannot reclaim one that nobody
 * tells it about. Pairing them to the component lifecycle is what makes the
 * bookkeeping correct without every call site remembering to clean up.
 *
 * Pass anything that is not a reference — a legacy `data:` URL, a remote URL,
 * null — and the hook stays inactive. That is what keeps the renderer
 * dual-read while conversations written before the store still exist. A
 * non-reference is deliberately distinct from a reference that resolved to
 * nothing: only the second is an error worth showing.
 *
 * "inactive" and "loading" are derived during render rather than written by
 * the effect, so the effect only ever sets state from its async callback.
 */
export function useMediaUrl(
  ref: string | null | undefined,
  { thumbnail = false }: AcquireOptions = {}
): MediaUrlState {
  const [settled, setSettled] = useState<Settled | null>(null)
  const [attempt, setAttempt] = useState(0)
  const loadMissing = useSessionMediaLoader()
  const retry = useCallback(() => setAttempt((value) => value + 1), [])
  const active = Boolean(ref) && isMediaRef(ref)

  useEffect(() => {
    if (!ref || !isMediaRef(ref)) return

    let cancelled = false
    // Whether THIS effect currently owns a holder. Load-bearing: for a
    // reference another component already resolved, `acquireMedia` increments
    // the count synchronously, so an unmount before the promise settles would
    // otherwise be released twice — once by the cleanup and once by the
    // cancelled branch — and the second release revokes a URL the other
    // component's <img> is still pointing at.
    let owns = false
    const release = () => {
      if (!owns) return
      owns = false
      releaseMedia(ref, { thumbnail })
    }

    void acquireMedia(ref, { thumbnail, loadMissing })
      .then((resolved: ResolvedMedia | null) => {
        // A null resolve never registered a holder, so there is nothing to own.
        if (resolved) owns = true
        if (cancelled) {
          release()
          return
        }
        setSettled({
          ref,
          thumbnail,
          state: {
            ...BASE_STATE,
            ...(resolved
              ? {
                  url: resolved.url,
                  width: resolved.width,
                  height: resolved.height,
                  isThumbnail: resolved.isThumbnail,
                  status: "ready" as const,
                }
              : { status: "missing" as const }),
            retry,
          },
        })
      })
      .catch(() => {
        if (!cancelled) {
          setSettled({
            ref,
            thumbnail,
            state: { ...BASE_STATE, status: "missing", retry },
          })
        }
      })

    return () => {
      cancelled = true
      release()
    }
  }, [attempt, loadMissing, ref, retry, thumbnail])

  if (!active) return { ...BASE_STATE, status: "inactive", retry }
  // Nothing settled yet, or settled for a different reference: still in flight.
  if (!settled || settled.ref !== ref || settled.thumbnail !== thumbnail) {
    return { ...BASE_STATE, status: "loading", retry }
  }
  return settled.state
}
