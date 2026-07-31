/**
 * Canvas/Artifact review engine — pure, dependency-free diff → hunk → apply.
 *
 * Extracted from `canvas-actions.ts` so consumers that only need the review
 * math (e.g. the artifact store, which is persisted and widely imported) don't
 * pull in the `ai` SDK + provider-core that `canvas-actions` loads at module
 * top. `canvas-actions` re-exports these for backward compatibility.
 */

import { nanoid } from "nanoid"
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
 * Generate a simple line-by-line diff preview between original and modified
 * content, with a small look-ahead so a single changed line in the middle of a
 * block reads as a replace rather than a full block swap.
 */
export function generateDiffPreview(original: string, modified: string): DiffLine[] {
  const originalLines = original.split("\n")
  const modifiedLines = modified.split("\n")
  const diff: DiffLine[] = []

  const maxLen = Math.max(originalLines.length, modifiedLines.length)
  let origIdx = 0
  let modIdx = 0

  while (origIdx < originalLines.length || modIdx < modifiedLines.length) {
    if (origIdx >= originalLines.length) {
      diff.push({
        type: "added",
        content: modifiedLines[modIdx],
        newLineNumber: modIdx + 1,
      })
      modIdx++
    } else if (modIdx >= modifiedLines.length) {
      diff.push({
        type: "removed",
        content: originalLines[origIdx],
        lineNumber: origIdx + 1,
      })
      origIdx++
    } else if (originalLines[origIdx] === modifiedLines[modIdx]) {
      diff.push({
        type: "unchanged",
        content: originalLines[origIdx],
        lineNumber: origIdx + 1,
        newLineNumber: modIdx + 1,
      })
      origIdx++
      modIdx++
    } else {
      const lookAhead = Math.min(5, maxLen - Math.max(origIdx, modIdx))
      let foundOrigMatch = -1
      let foundModMatch = -1

      for (let i = 1; i <= lookAhead; i++) {
        if (
          modIdx + i < modifiedLines.length &&
          originalLines[origIdx] === modifiedLines[modIdx + i]
        ) {
          foundModMatch = modIdx + i
          break
        }
        if (
          origIdx + i < originalLines.length &&
          originalLines[origIdx + i] === modifiedLines[modIdx]
        ) {
          foundOrigMatch = origIdx + i
          break
        }
      }

      if (foundModMatch >= 0) {
        while (modIdx < foundModMatch) {
          diff.push({
            type: "added",
            content: modifiedLines[modIdx],
            newLineNumber: modIdx + 1,
          })
          modIdx++
        }
      } else if (foundOrigMatch >= 0) {
        while (origIdx < foundOrigMatch) {
          diff.push({
            type: "removed",
            content: originalLines[origIdx],
            lineNumber: origIdx + 1,
          })
          origIdx++
        }
      } else {
        diff.push({
          type: "removed",
          content: originalLines[origIdx],
          lineNumber: origIdx + 1,
        })
        diff.push({
          type: "added",
          content: modifiedLines[modIdx],
          newLineNumber: modIdx + 1,
        })
        origIdx++
        modIdx++
      }
    }
  }

  return diff
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
    createdAt: new Date(),
    status: "pending",
    items,
  }
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
