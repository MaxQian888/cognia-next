"use client"

/**
 * Persisted per-hunk review decisions (accept / reject / comment) for the source
 * control diff viewer. Decisions are small + advisory (the durable git effect
 * happens when the user clicks "Apply accepted", routed through the existing
 * stage path), so localStorage via zustand `persist` is the right weight — no
 * Dexie schema bump. Mirrors the `cognia-git-ui` store conventions.
 *
 * Decisions are keyed by {@link diffReviewFileKey}(rootDir, reviewKey)
 * (rootDir-scoped to avoid cross-repo collisions); `reviewKey` comes from
 * `lib/git/hunk-review:normalizeReviewKey`. A soft LRU cap bounds growth.
 */

import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"

import type { HunkDecision, StoredHunkDecision } from "@/lib/git/hunk-review"

/** Max distinct files retained before the least-recently-touched is evicted. */
export const DIFF_REVIEW_FILE_CAP = 200

/**
 * Composite localStorage key for one file's decisions. Newline separator — paths
 * and review keys never contain one, so it can't collide across (rootDir,
 * reviewKey) pairs. Exported so readers (the review list) and writers use one
 * key construction.
 */
export function diffReviewFileKey(rootDir: string, reviewKey: string): string {
  return `${rootDir}\n${reviewKey}`
}

interface DiffReviewState {
  /** fileKey → decisions for that file. */
  decisions: Record<string, StoredHunkDecision[]>
  /** LRU order of fileKeys, oldest first. */
  order: string[]
  setDecision: (
    rootDir: string,
    reviewKey: string,
    hunkIndex: number,
    hash: string,
    decision: HunkDecision
  ) => void
  setComment: (
    rootDir: string,
    reviewKey: string,
    hunkIndex: number,
    hash: string,
    comment: string
  ) => void
  getFileDecisions: (rootDir: string, reviewKey: string) => StoredHunkDecision[]
  clearFile: (rootDir: string, reviewKey: string) => void
}

/** Upsert one entry (by hash) into a file's decision list, applying a patch. */
function upsert(
  list: StoredHunkDecision[],
  hunkIndex: number,
  hash: string,
  patch: Partial<StoredHunkDecision>
): StoredHunkDecision[] {
  const idx = list.findIndex((d) => d.hash === hash)
  if (idx === -1) {
    return [...list, { hunkIndex, hash, decision: "undecided", ...patch }]
  }
  const next = list.slice()
  next[idx] = { ...next[idx], hunkIndex, ...patch }
  return next
}

export const useDiffReviewStore = create<DiffReviewState>()(
  persist(
    (set, get) => {
      // Touch a fileKey: update its decisions + bump LRU, evicting the overflow.
      const writeFile = (key: string, list: StoredHunkDecision[]) =>
        set((s) => {
          const order = s.order.filter((k) => k !== key)
          order.push(key)
          const decisions = { ...s.decisions, [key]: list }
          while (order.length > DIFF_REVIEW_FILE_CAP) {
            const evicted = order.shift()
            if (evicted) delete decisions[evicted]
          }
          return { decisions, order }
        })

      return {
        decisions: {},
        order: [],

        setDecision: (rootDir, reviewKey, hunkIndex, hash, decision) => {
          const key = diffReviewFileKey(rootDir, reviewKey)
          writeFile(key, upsert(get().decisions[key] ?? [], hunkIndex, hash, { decision }))
        },

        setComment: (rootDir, reviewKey, hunkIndex, hash, comment) => {
          const key = diffReviewFileKey(rootDir, reviewKey)
          writeFile(key, upsert(get().decisions[key] ?? [], hunkIndex, hash, { comment }))
        },

        getFileDecisions: (rootDir, reviewKey) =>
          get().decisions[diffReviewFileKey(rootDir, reviewKey)] ?? [],

        clearFile: (rootDir, reviewKey) =>
          set((s) => {
            const key = diffReviewFileKey(rootDir, reviewKey)
            if (!(key in s.decisions)) return s
            const decisions = { ...s.decisions }
            delete decisions[key]
            return { decisions, order: s.order.filter((k) => k !== key) }
          }),
      }
    },
    {
      name: "cognia-git-review",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ decisions: s.decisions, order: s.order }),
    }
  )
)
