"use client"

/**
 * `useGitRead(key, fetcher)` — one keyed read-only git call, with the three
 * outcomes a surface has to render: data, loading, failed-with-retry.
 *
 * Every read surface in Source Control used to spell this as
 * `void gitX(...).then(set)`, which has two holes:
 *
 *  - No rejection path. A failed read (a transport drop, a repository deleted
 *    underneath the panel) became an unhandled rejection and the surface sat
 *    in its loading or "empty" state for good, which reads as "no history" or
 *    "no remotes" rather than "could not ask".
 *  - No key on the result. The last value held in local state was returned
 *    for whatever was asked next, so selecting a second file showed the FIRST
 *    file's diff until the second one arrived.
 *
 * The result is recorded together with the key (and retry attempt) it
 * answered, and is only returned while the caller still asks for that key.
 * A changed key therefore reads as loading, never as the previous answer.
 *
 * Re-running for the SAME key (`enabled` flipping back on, or the fetcher's
 * inputs changing under an unchanged key) keeps the previous answer on screen
 * until the new one lands: stale-while-revalidate, so a background refresh
 * never blanks a diff the user is reading.
 *
 * `loading` is derived during render rather than set in the effect, which
 * keeps `react-hooks/set-state-in-effect` satisfied and means the first frame
 * after a key change already says "loading". Pair it with `useDeferredLoading`
 * to keep sub-perceptible waits from flashing an indicator.
 */

import { useCallback, useEffect, useState } from "react"
import { gitErrorDetail } from "@/lib/git/load"
import { useStableCallback } from "@/hooks/ui/use-stable-callback"

export interface GitReadOptions<T> {
  /** When false nothing is fetched; a held answer for the same key stays. */
  enabled?: boolean
  /**
   * A value whose change re-runs the read for the SAME key, dropping any read
   * still in flight. For inputs that move under an unchanged key: a status
   * write that lands while a diff is being read means that read may already
   * be out of date, and it must not be the one that wins.
   */
  revision?: unknown
  /**
   * Called with each answer that is still current when it lands, i.e. not
   * superseded by a key change, a `revision` change or an unmount. The place
   * to write a cache, because a write from inside the fetcher would also land
   * for a superseded read.
   */
  onData?: (data: T) => void
}

export interface GitReadResult<T> {
  /** The answer for the CURRENT key, or undefined until one exists. */
  data: T | undefined
  /** Why the latest read for the current key failed, or null. */
  error: string | null
  /** A read for the current key is outstanding and nothing answers it yet. */
  loading: boolean
  /** Re-run the read for the current key. */
  retry: () => void
}

interface Settled<T> {
  key: string
  attempt: number
  data: T | undefined
  error: string | null
}

export function useGitRead<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  { enabled = true, revision, onData }: GitReadOptions<T> = {}
): GitReadResult<T> {
  const [attempt, setAttempt] = useState(0)
  const [settled, setSettled] = useState<Settled<T> | null>(null)
  const read = useStableCallback(fetcher)
  const deliver = useStableCallback((data: T) => onData?.(data))
  const active = enabled && key !== null

  useEffect(() => {
    if (!active || key === null) return
    let alive = true
    read().then(
      (data) => {
        if (!alive) return
        deliver(data)
        setSettled({ key, attempt, data, error: null })
      },
      (error: unknown) => {
        if (!alive) return
        // Keep a same-key answer: a failed background refresh must not blank
        // the last good result, only say that refreshing it failed.
        setSettled((prev) => ({
          key,
          attempt,
          data: prev?.key === key ? prev.data : undefined,
          error: gitErrorDetail(error),
        }))
      }
    )
    return () => {
      alive = false
    }
  }, [active, key, attempt, revision, read, deliver])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  const current = settled !== null && settled.key === key ? settled : null
  const data = current?.data
  // Outstanding: this key has never settled, or a retry has not answered yet.
  // A pending retry hides the error it is retrying, so the row stops saying
  // "failed" the moment the user asks again.
  const pending = active && (current === null || current.attempt !== attempt)
  const error = pending ? null : (current?.error ?? null)
  const loading = pending && data === undefined

  return { data, error, loading, retry }
}
