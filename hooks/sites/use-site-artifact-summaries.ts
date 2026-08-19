"use client"

/**
 * Artifact size and file count for the versions tab.
 *
 * `siteVersions` rows carry only a digest; the size and file count live on the
 * `siteArtifacts` row next to the archive bytes. Reading a row therefore pulls
 * megabytes into memory, so this loads **one artifact at a time**, only for the
 * digests actually on screen, only while the caller says it needs them, and
 * caches the two numbers so a digest is never read twice.
 *
 * The first version of this was an `onFocus` handler on the tab panel — which
 * only fires when someone tabs into it with the keyboard, so in practice the
 * numbers never arrived and every version rendered as "no artifact".
 */
import { useEffect, useRef, useState } from "react"

import { getSiteArtifact } from "@/lib/db/sites"
import type { SiteVersionRow } from "@/types/sites"

export interface SiteArtifactSummary {
  size: number
  fileCount: number
}

export interface SiteArtifactSummariesDeps {
  read: typeof getSiteArtifact
}

/**
 * @param versions rows whose artifacts may be summarized.
 * @param enabled false while the versions tab is not showing, so switching to
 *   another tab never pays for a read.
 */
export function useSiteArtifactSummaries(
  versions: readonly SiteVersionRow[],
  enabled: boolean,
  dependencies?: Partial<SiteArtifactSummariesDeps>
): ReadonlyMap<string, SiteArtifactSummary> {
  // Captured once: a test seam, never reactive input.
  const depsRef = useRef<SiteArtifactSummariesDeps>({
    read: getSiteArtifact,
    ...dependencies,
  })
  const [summaries, setSummaries] = useState<ReadonlyMap<string, SiteArtifactSummary>>(new Map())
  // Digests already attempted, so a missing artifact is not retried forever.
  const attempted = useRef(new Set<string>())

  // A stable key: the effect must re-run when a new version appears, not on
  // every re-render of the same list.
  const digestKey = enabled
    ? versions
        .map((version) => version.artifactDigest)
        .filter((digest): digest is string => Boolean(digest))
        .join(",")
    : ""

  useEffect(() => {
    if (!digestKey) return
    let cancelled = false
    const pending = digestKey.split(",").filter((digest) => !attempted.current.has(digest))
    if (pending.length === 0) return

    void (async () => {
      for (const digest of pending) {
        if (cancelled) return
        attempted.current.add(digest)
        try {
          const row = await depsRef.current.read(digest)
          if (cancelled) return
          if (!row) continue
          const summary = { size: row.size, fileCount: row.fileCount }
          setSummaries((previous) => new Map(previous).set(digest, summary))
        } catch {
          // A missing or unreadable artifact simply has no summary; the row
          // already says "no artifact" rather than claiming a size.
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [digestKey])

  return summaries
}
