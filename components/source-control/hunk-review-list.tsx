"use client"

/**
 * Review list beside the diff viewer: accept / reject / comment per hunk, with
 * decisions persisted (content-addressed, so they survive a re-diff) and an
 * "Apply accepted" action that stages the accepted hunks through the existing
 * git stage path. Working-tree (unstaged) files only.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { diffReviewFileKey, useDiffReviewStore } from "@/stores/git/diff-review-store"
import {
  countUnmappedDecisions,
  hunkContentHash,
  normalizeReviewKey,
  replayDecisions,
  selectAcceptedPatches,
  type HunkDecision,
} from "@/lib/git/hunk-review"
import type { GitDiff, GitFileChange } from "@/types/git"
import { HunkReviewItem } from "./hunk-review-item"

interface Props {
  rootDir: string
  change: GitFileChange
  diff: GitDiff
  /** Stage one hunk patch (existing git stage path). */
  onStagePatch: (patch: string) => Promise<void>
  /** Invalidate the cached diff so it re-fetches after applying. */
  onInvalidate: () => void
}

export function HunkReviewList({ rootDir, change, diff, onStagePatch, onInvalidate }: Props) {
  const t = useTranslations("sourceControl.review")
  const [applying, setApplying] = useState(false)
  const setDecision = useDiffReviewStore((s) => s.setDecision)
  const setComment = useDiffReviewStore((s) => s.setComment)
  const clearFile = useDiffReviewStore((s) => s.clearFile)
  // Subscribe to this file's slice so decisions re-render on change.
  const reviewKey = normalizeReviewKey(change)
  const stored = useDiffReviewStore((s) => s.decisions[diffReviewFileKey(rootDir, reviewKey)])

  const remapped = useMemo(() => replayDecisions(stored ?? [], diff.hunks), [stored, diff.hunks])
  const unmapped = useMemo(
    () => countUnmappedDecisions(stored ?? [], diff.hunks),
    [stored, diff.hunks]
  )
  const acceptedCount = useMemo(
    () => [...remapped.values()].filter((d) => d.decision === "accepted").length,
    [remapped]
  )

  const handleDecision = useCallback(
    (index: number, decision: HunkDecision) => {
      setDecision(rootDir, reviewKey, index, hunkContentHash(diff.hunks[index]), decision)
    },
    [setDecision, rootDir, reviewKey, diff.hunks]
  )

  const handleComment = useCallback(
    (index: number, comment: string) => {
      setComment(rootDir, reviewKey, index, hunkContentHash(diff.hunks[index]), comment)
    },
    [setComment, rootDir, reviewKey, diff.hunks]
  )

  const applyAccepted = useCallback(async () => {
    const patches = selectAcceptedPatches(diff.hunks, remapped)
    if (patches.length === 0) return
    setApplying(true)
    try {
      // Reverse `newStart` order (already sorted) so earlier stages don't shift
      // later offsets; re-fetch happens once afterwards via onInvalidate.
      for (const hunk of patches) {
        await onStagePatch(hunk.patch)
      }
      clearFile(rootDir, reviewKey)
      onInvalidate()
    } finally {
      setApplying(false)
    }
  }, [diff.hunks, remapped, onStagePatch, clearFile, rootDir, reviewKey, onInvalidate])

  if (diff.hunks.length === 0) return null

  return (
    <div className="space-y-2 border-t p-3" data-testid="hunk-review-list">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] uppercase text-muted-foreground">{t("title")}</p>
        <span className="text-[11px] text-muted-foreground" data-testid="accepted-count">
          {t("acceptedCount", { accepted: acceptedCount, total: diff.hunks.length })}
        </span>
      </div>

      {diff.hunks.map((hunk, index) => {
        const d = remapped.get(index)
        return (
          <HunkReviewItem
            key={`${index}-${hunkContentHash(hunk)}`}
            hunk={hunk}
            index={index}
            decision={d?.decision ?? "undecided"}
            comment={d?.comment}
            onDecision={handleDecision}
            onComment={handleComment}
            disabled={applying}
          />
        )
      })}

      {unmapped > 0 && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400" data-testid="remap-notice">
          {t("remapNotice", { count: unmapped })}
        </p>
      )}

      <Button
        type="button"
        size="sm"
        className="w-full"
        disabled={applying || acceptedCount === 0}
        onClick={() => void applyAccepted()}
        data-testid="apply-accepted"
      >
        {t("applyAccepted", { count: acceptedCount })}
      </Button>
    </div>
  )
}
