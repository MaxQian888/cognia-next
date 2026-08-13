"use client"

/**
 * Review list beside the diff viewer: accept / reject / comment per hunk, with
 * decisions persisted (content-addressed, so they survive a re-diff) and an
 * "Apply accepted" action that stages the accepted hunks through the existing
 * git stage path. Working-tree (unstaged) files only.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, ChevronUpIcon, SparklesIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { diffReviewFileKey, useDiffReviewStore } from "@/stores/git/diff-review-store"
import {
  countUnmappedDecisions,
  hunkContentHash,
  normalizeReviewKey,
  replayDecisions,
  selectAcceptedPatches,
  type HunkDecision,
} from "@/lib/git/hunk-review"
import { useAiDiffReview } from "@/hooks/git/use-ai-diff-review"
import type { GitActionResult } from "@/hooks/git/use-git-actions"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { cn } from "@/lib/utils"
import type { GitDiff, GitFileChange } from "@/types/git"
import { HunkReviewItem } from "./hunk-review-item"

interface Props {
  rootDir: string
  change: GitFileChange
  diff: GitDiff
  /** Stage one hunk patch (existing git stage path). */
  onStagePatch: (patch: string) => Promise<GitActionResult | void>
  canStage?: boolean
  /** Invalidate the cached diff so it re-fetches after applying. */
  onInvalidate: () => void
  /** Collapsed shows only the header bar so the diff above keeps the space. */
  collapsed?: boolean
  /** Toggle the collapsed/expanded state (owned by the parent DiffPane). */
  onToggleCollapse?: () => void
  density?: "compact" | "touch"
}

export function HunkReviewList({
  rootDir,
  change,
  diff,
  onStagePatch,
  canStage = true,
  onInvalidate,
  collapsed = false,
  onToggleCollapse,
  density = "compact",
}: Props) {
  const t = useTranslations("sourceControl.review")
  const [applying, setApplying] = useState(false)
  const setDecision = useDiffReviewStore((s) => s.setDecision)
  const setComment = useDiffReviewStore((s) => s.setComment)
  const clearFile = useDiffReviewStore((s) => s.clearFile)
  const clearAiFindings = useDiffReviewStore((s) => s.clearAiFindings)
  // Subscribe to this file's slice so decisions re-render on change.
  const reviewKey = normalizeReviewKey(change)
  const stored = useDiffReviewStore((s) => s.decisions[diffReviewFileKey(rootDir, reviewKey)])

  const aiEnabled = useSettingsStore((s) => s.settings?.gitSettings?.reviewAI?.enabled ?? false)
  const { reviewing, review } = useAiDiffReview(rootDir, change, diff)

  const remapped = useMemo(() => replayDecisions(stored ?? [], diff.hunks), [stored, diff.hunks])
  const hasAiFindings = useMemo(() => [...remapped.values()].some((d) => d.ai), [remapped])
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
      let appliedAny = false
      for (const hunk of patches) {
        const failure = await onStagePatch(hunk.patch)
        if (failure) {
          if (appliedAny) onInvalidate()
          return
        }
        appliedAny = true
      }
      clearFile(rootDir, reviewKey)
      onInvalidate()
    } finally {
      setApplying(false)
    }
  }, [diff.hunks, remapped, onStagePatch, clearFile, rootDir, reviewKey, onInvalidate])

  if (diff.hunks.length === 0) return null

  const header = (
    <div className="flex items-center justify-between gap-2 px-3 py-2">
      <div className="flex min-w-0 items-center gap-1.5">
        {onToggleCollapse && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "size-5 text-muted-foreground hover:text-foreground",
              density === "touch" && "size-11"
            )}
            aria-label={collapsed ? t("expand") : t("collapse")}
            aria-expanded={!collapsed}
            onClick={onToggleCollapse}
            data-testid="review-collapse-toggle"
          >
            {collapsed ? (
              <ChevronUpIcon className="size-3.5" />
            ) : (
              <ChevronDownIcon className="size-3.5" />
            )}
          </Button>
        )}
        <p className="truncate text-[10px] uppercase text-muted-foreground">{t("title")}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {aiEnabled && (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn("h-6 gap-1 px-1.5 text-[11px]", density === "touch" && "h-11 px-3")}
              disabled={reviewing}
              onClick={() => void review()}
              data-testid="ai-review-run"
            >
              {reviewing ? <Spinner className="size-3" /> : <SparklesIcon className="size-3" />}
              {t("ai.run")}
            </Button>
            {hasAiFindings && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  "size-6 text-muted-foreground hover:text-foreground",
                  density === "touch" && "size-11"
                )}
                aria-label={t("ai.clear")}
                disabled={reviewing}
                onClick={() => clearAiFindings(rootDir, reviewKey)}
                data-testid="ai-review-clear"
              >
                <XIcon className="size-3.5" />
              </Button>
            )}
          </>
        )}
        <span className="text-[11px] text-muted-foreground" data-testid="accepted-count">
          {t("acceptedCount", { accepted: acceptedCount, total: diff.hunks.length })}
        </span>
      </div>
    </div>
  )

  // Collapsed: render the header bar only so the diff viewer above keeps its
  // full height (this container is shrink-0 in the parent flex column).
  if (collapsed) {
    return (
      <div className="shrink-0 border-t" data-testid="hunk-review-list" data-collapsed="true">
        {header}
      </div>
    )
  }

  // Expanded: fill the resizable panel; the hunk list scrolls internally so it
  // never grows past its allotted height and squeezes the diff above.
  return (
    <div
      className="flex h-full min-h-0 flex-col border-t"
      data-testid="hunk-review-list"
      data-collapsed="false"
    >
      <div className="shrink-0">{header}</div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-2">
        {diff.hunks.map((hunk, index) => {
          const d = remapped.get(index)
          return (
            <HunkReviewItem
              key={`${index}-${hunkContentHash(hunk)}`}
              hunk={hunk}
              index={index}
              decision={d?.decision ?? "undecided"}
              comment={d?.comment}
              ai={d?.ai}
              onDecision={handleDecision}
              onComment={handleComment}
              disabled={applying}
              density={density}
            />
          )
        })}

        {unmapped > 0 && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400" data-testid="remap-notice">
            {t("remapNotice", { count: unmapped })}
          </p>
        )}
      </div>

      <div className="shrink-0 border-t p-3">
        <Button
          type="button"
          size="sm"
          className={cn("w-full", density === "touch" && "h-11")}
          disabled={!canStage || applying || acceptedCount === 0}
          onClick={() => void applyAccepted()}
          data-testid="apply-accepted"
        >
          {t("applyAccepted", { count: acceptedCount })}
        </Button>
      </div>
    </div>
  )
}
