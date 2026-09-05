"use client"

/**
 * Comment anchors that follow the text.
 *
 * A Canvas comment is stored with absolute offsets and a revision, and
 * `isContextCommentAnchorStale` greys the whole thread out the moment the
 * revision moves. That is the only honest thing to do with an offset, because
 * one line inserted at the top of a document invalidates every offset below
 * it. The cost is that a comment goes stale for edits that had nothing to do
 * with it, and the author has to go and find the line again.
 *
 * When a shared document is open, this hook adds a second, relative anchor at
 * write time and resolves it at read time, so the comment names the characters
 * rather than their index.
 *
 * Both halves degrade to nothing rather than to something wrong. With no
 * session, `encode` returns `undefined` and the comment is stored exactly as
 * it was before, and `resolve` hands the anchor back untouched.
 */

import { useCallback, useMemo } from "react"

import { crdtStore } from "@/lib/canvas/collaboration/crdt-store"
import {
  encodeCrdtAnchor,
  lineRangeFromOffsets,
  resolveCrdtAnchor,
} from "@/lib/canvas/collaboration/relative-anchor"
import type { CanvasCrdtAnchor } from "@/types/canvas/collaboration"
import type { ContextCommentAnchor } from "@/types/context-comment"

export interface CanvasCommentAnchors {
  /** The CRDT anchor for a selection, or `undefined` when there is no session. */
  encode: (start: number, end: number) => CanvasCrdtAnchor | undefined
  /** An anchor brought up to date, or the same anchor when it cannot be. */
  resolve: (anchor: ContextCommentAnchor) => ContextCommentAnchor
}

export function useCanvasCommentAnchors(documentId: string | null): CanvasCommentAnchors {
  const encode = useCallback(
    (start: number, end: number): CanvasCrdtAnchor | undefined => {
      if (!documentId) return undefined
      const sessionId = crdtStore.sessionIdForDocument(documentId)
      if (!sessionId) return undefined
      const text = crdtStore.getYText(sessionId)
      if (!text) return undefined
      return encodeCrdtAnchor(text, start, end) ?? undefined
    },
    [documentId]
  )

  const resolve = useCallback(
    (anchor: ContextCommentAnchor): ContextCommentAnchor => {
      if (anchor.kind !== "text-range" || !anchor.crdt || !documentId) return anchor
      const sessionId = crdtStore.sessionIdForDocument(documentId)
      if (!sessionId) return anchor
      const doc = crdtStore.getYDoc(sessionId)
      const text = crdtStore.getYText(sessionId)
      if (!doc || !text) return anchor
      const resolved = resolveCrdtAnchor(doc, anchor.crdt)
      // Two ways the text a comment named can be gone, and both mean the same
      // thing to a reader.
      //
      // The anchor may fail to resolve outright. Or it may resolve to an empty
      // range where it used to cover something, which is what deleting the
      // commented span does: both ends survive and collapse onto each other.
      // Reporting that as a real position would render the comment as being
      // about wherever the collapse landed, which is usually the top of the
      // document and never what was meant.
      //
      // Leaving the stored offsets in place keeps the revision check working,
      // so the thread reports itself stale rather than pointing somewhere
      // confidently wrong.
      const collapsed = resolved !== null && resolved.end === resolved.start
      const wasEmpty = anchor.end === anchor.start
      if (!resolved || (collapsed && !wasEmpty)) return anchor
      return {
        ...anchor,
        start: resolved.start,
        end: resolved.end,
        lineRange: lineRangeFromOffsets(text.toString(), resolved.start, resolved.end),
      }
    },
    [documentId]
  )

  return useMemo(() => ({ encode, resolve }), [encode, resolve])
}

export default useCanvasCommentAnchors
