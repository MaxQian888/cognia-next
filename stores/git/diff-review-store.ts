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
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"

import type { HunkDecision, StoredHunkDecision } from "@/lib/git/hunk-review"
import type { HunkAiFinding } from "@/types/git"

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
  /** Attach (or clear) an AI review finding on one hunk. `null` removes it. */
  setAiFinding: (
    rootDir: string,
    reviewKey: string,
    hunkIndex: number,
    hash: string,
    ai: HunkAiFinding | null
  ) => void
  /** Drop AI findings from every hunk of a file, keeping human decisions/comments. */
  clearAiFindings: (rootDir: string, reviewKey: string) => void
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

/** Persisted slice shape (see `partialize`). */
type PersistedDiffReviewState = Pick<DiffReviewState, "decisions" | "order">

/**
 * v1 → v2: identical persisted shape (`ai` is a new optional field entries
 * simply lack), so the migration is the identity. Exported for tests.
 */
export function migrateDiffReviewState(
  persisted: unknown,
  _version: number
): PersistedDiffReviewState {
  return persisted as PersistedDiffReviewState
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

        setAiFinding: (rootDir, reviewKey, hunkIndex, hash, ai) => {
          const key = diffReviewFileKey(rootDir, reviewKey)
          writeFile(
            key,
            upsert(get().decisions[key] ?? [], hunkIndex, hash, { ai: ai ?? undefined })
          )
        },

        clearAiFindings: (rootDir, reviewKey) => {
          const key = diffReviewFileKey(rootDir, reviewKey)
          const list = get().decisions[key]
          if (!list) return
          // Strip `ai` from each entry, then drop entries left with no signal.
          const next = list
            .map(({ ai: _ai, ...rest }) => rest)
            .filter((d) => d.decision !== "undecided" || d.comment)
          writeFile(key, next)
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
      // v2 adds the optional `ai` finding field on decisions; older persisted
      // entries simply lack it. The shape is read-compatible, but zustand
      // DISCARDS persisted state on any version mismatch unless a `migrate`
      // is provided — so an identity migrate is load-bearing here.
      version: 2,
      migrate: migrateDiffReviewState,
      storage: persistLocalStorage(),
      partialize: (s) => ({ decisions: s.decisions, order: s.order }),
    }
  )
)
