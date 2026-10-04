"use client"

/**
 * Live view of the Pi packages contributed by enabled plugins (ADR-0210).
 *
 * Two layers, deliberately separate:
 *
 *   - the registry list, read synchronously through `useSyncExternalStore`, so
 *     a plugin enabled after first paint shows up without a reload;
 *   - the per-package resolution (absolute paths, prepare state, or the typed
 *     refusal such as `not-on-disk`), which needs an async marker probe and is
 *     recomputed whenever the registry changes or `refresh()` is called.
 *
 * `loading` is derived from "what the resolution was computed for" rather than
 * stored, which keeps the effect free of a synchronous `setState`.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react"

import {
  getContributedPiPackagesRevision,
  listContributedPiPackages,
  subscribeContributedPiPackages,
  type ContributedPiPackage,
} from "@/lib/plugin/pi-packages/registry"
import {
  PiPackageResolutionError,
  resolveContributedPiPackage,
  type ResolvedContributedPiPackage,
} from "@/lib/plugin/pi-packages/resolve"

export interface ContributedPiPackageView {
  entry: ContributedPiPackage
  /** Present when the package resolves; `null` while loading or on refusal. */
  resolved: ResolvedContributedPiPackage | null
  /** The typed refusal (e.g. `not-on-disk` for a built-in plugin). */
  error: PiPackageResolutionError | null
}

export interface UseContributedPiPackagesResult {
  packages: ContributedPiPackageView[]
  loading: boolean
  /** Re-probe prepare markers (after a prepare run, say). */
  refresh: () => void
}

type Resolution = {
  resolved: ResolvedContributedPiPackage | null
  error: PiPackageResolutionError | null
}

/** Registry entries, optionally narrowed to one plugin. Stable per revision. */
export function useContributedPiPackageEntries(pluginId?: string): ContributedPiPackage[] {
  const revision = useSyncExternalStore(
    subscribeContributedPiPackages,
    getContributedPiPackagesRevision,
    getContributedPiPackagesRevision
  )
  return useMemo(() => {
    // `revision` is the cache key: the registry list is re-read whenever it moves.
    void revision
    const all = listContributedPiPackages()
    return pluginId ? all.filter((entry) => entry.pluginId === pluginId) : all
  }, [revision, pluginId])
}

export function useContributedPiPackages(pluginId?: string): UseContributedPiPackagesResult {
  const entries = useContributedPiPackageEntries(pluginId)
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<{
    entries: ContributedPiPackage[]
    nonce: number
    results: Map<string, Resolution>
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all(
      entries.map(async (entry): Promise<[string, Resolution]> => {
        try {
          return [
            entry.ref,
            { resolved: await resolveContributedPiPackage(entry.ref), error: null },
          ]
        } catch (error) {
          return [
            entry.ref,
            {
              resolved: null,
              error:
                error instanceof PiPackageResolutionError
                  ? error
                  : // An unexpected failure is reported as one — never relabelled
                    // as "no enabled plugin provides this package".
                    Object.assign(
                      new PiPackageResolutionError(
                        "resolution-failed",
                        entry.ref,
                        error instanceof Error ? error.message : String(error)
                      ),
                      { cause: error }
                    ),
            },
          ]
        }
      })
    ).then((pairs) => {
      if (!cancelled) setState({ entries, nonce, results: new Map(pairs) })
    })
    return () => {
      cancelled = true
    }
  }, [entries, nonce])

  const loading = state === null || state.entries !== entries || state.nonce !== nonce

  const packages = useMemo(
    () =>
      entries.map((entry) => {
        const result = state?.entries === entries ? state.results.get(entry.ref) : undefined
        return { entry, resolved: result?.resolved ?? null, error: result?.error ?? null }
      }),
    [entries, state]
  )

  const refresh = useCallback(() => setNonce((current) => current + 1), [])

  return { packages, loading, refresh }
}
