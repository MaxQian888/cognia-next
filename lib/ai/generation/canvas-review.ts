/**
 * Canvas/Artifact review engine: diff, hunk, apply.
 *
 * Extracted from `canvas-actions.ts` so consumers that only need the review
 * math (e.g. the artifact store, which is persisted and widely imported) don't
 * pull in the `ai` SDK + provider-core that `canvas-actions` loads at module
 * top. `canvas-actions` re-exports these for backward compatibility.
 *
 * The diff itself is `lib/artifacts/diff.ts:computeDiff`, an LCS diff that the
 * review UI was ALREADY using to render. This module used to carry a second,
 * hand-written diff with a five-line lookahead, so the hunks the user accepted
 * were computed by one algorithm and the diff they read was drawn by another.
 * On a block move the two disagree about which lines changed, and the accepted
 * hunk is applied at line numbers the reader never saw.
 */

import { nanoid } from "nanoid"
import { computeDiff } from "@/lib/artifacts/diff"
import { hashCanvasContent } from "@/lib/canvas/content-hash"
import type {
  CanvasPendingReview,
  CanvasReviewDiffLine,
  CanvasReviewItem,
  CanvasWorkbenchActionType,
} from "@/types/artifact/artifact"

export type DiffLine = CanvasReviewDiffLine

export interface CanvasReviewBuildInput {
  requestId: string
  actionType: CanvasWorkbenchActionType
  originalContent: string
  proposedContent: string
}

/**
 * The line diff a review is built from, in the review's own line-number shape.
 *
 * A thin translation of `computeDiff` rather than a second implementation:
 * `DiffLine` (artifacts) names its fields `oldLineNum`/`newLineNum`, while
 * `CanvasReviewDiffLine` names them `lineNumber`/`newLineNumber`. Keeping the
 * two shapes is cheap; keeping two diff algorithms was not.
 */
export function generateDiffPreview(original: string, modified: string): DiffLine[] {
  return computeDiff(original, modified).map((line) => ({
    type: line.type,
    content: line.content,
    ...(line.oldLineNum !== undefined ? { lineNumber: line.oldLineNum } : {}),
    ...(line.newLineNum !== undefined ? { newLineNumber: line.newLineNum } : {}),
  }))
}

/**
 * Group a line diff into per-hunk review items (contiguous added/removed runs),
 * each independently accept/reject-able.
 */
export function buildCanvasReview(input: CanvasReviewBuildInput): CanvasPendingReview {
  const diffLines = generateDiffPreview(input.originalContent, input.proposedContent)
  const items: CanvasReviewItem[] = []
  let block: DiffLine[] = []
  let fallbackStartLine = 1

  const flushBlock = () => {
    if (block.length === 0) {
      return
    }

    const removedLines = block.filter((line) => line.type === "removed")
    const addedLines = block.filter((line) => line.type === "added")
    const startLine =
      removedLines[0]?.lineNumber ?? addedLines[0]?.newLineNumber ?? fallbackStartLine
    const endLine =
      removedLines.length > 0
        ? (removedLines[removedLines.length - 1].lineNumber ?? startLine)
        : startLine - 1

    let changeType: CanvasReviewItem["changeType"] = "replace"
    if (removedLines.length === 0 && addedLines.length > 0) {
      changeType = "insert"
    } else if (removedLines.length > 0 && addedLines.length === 0) {
      changeType = "delete"
    }

    items.push({
      id: nanoid(),
      actionType: input.actionType,
      changeType,
      originalText: removedLines.map((line) => line.content).join("\n"),
      proposedText: addedLines.map((line) => line.content).join("\n"),
      status: "pending",
      range: {
        startLine,
        endLine,
      },
      diffLines: block.map((line) => ({ ...line })),
    })

    block = []
  }

  for (const line of diffLines) {
    if (line.type === "unchanged") {
      flushBlock()
      fallbackStartLine = (line.lineNumber ?? fallbackStartLine) + 1
      continue
    }

    if (block.length === 0) {
      fallbackStartLine = line.lineNumber ?? line.newLineNumber ?? fallbackStartLine
    }
    block.push(line)
  }
  flushBlock()

  return {
    id: nanoid(),
    requestId: input.requestId,
    actionType: input.actionType,
    originalContent: input.originalContent,
    proposedContent: input.proposedContent,
    baseContentHash: hashCanvasContent(input.originalContent),
    createdAt: new Date(),
    status: "pending",
    items,
  }
}

/**
 * Whether a proposal still describes the document in front of the user.
 *
 * Derived, not remembered. `isStale` was a flag `updateCanvasDocument` had to
 * remember to set, so a proposal that survived a reload, or a buffer changed by
 * a path that did not go through that action, could be applied against content
 * it was never diffed from. Applying accepted hunks by line number onto moved
 * content corrupts the document silently.
 *
 * A proposal written before the hash existed falls back to comparing the
 * baseline text, which is what the flag was approximating.
 */
export function isCanvasReviewStale(
  review: Pick<CanvasPendingReview, "originalContent" | "baseContentHash" | "isStale">,
  currentContent: string
): boolean {
  if (review.isStale === true) return true
  if (review.baseContentHash) return review.baseContentHash !== hashCanvasContent(currentContent)
  return review.originalContent !== currentContent
}

/**
 * Reconstruct content by applying only the accepted hunks. Items are applied
 * back-to-front so earlier line indices stay valid as later ones mutate.
 */
export function applyAcceptedCanvasReviewItems(
  originalContent: string,
  items: CanvasReviewItem[]
): string {
  const lines = originalContent.split("\n")
  const acceptedItems = items
    .filter((item) => item.status === "accepted")
    .sort((a, b) => b.range.startLine - a.range.startLine)

  for (const item of acceptedItems) {
    const startIndex = Math.max(0, item.range.startLine - 1)
    const deleteCount =
      item.range.endLine >= item.range.startLine ? item.range.endLine - item.range.startLine + 1 : 0
    const replacementLines = item.proposedText.length > 0 ? item.proposedText.split("\n") : []
    lines.splice(startIndex, deleteCount, ...replacementLines)
  }

  return lines.join("\n")
}
