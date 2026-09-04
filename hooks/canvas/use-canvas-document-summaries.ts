"use client"

/**
 * The document rail and tab strip need a *list* of documents; the editor needs
 * exactly one. `useArtifactStore((s) => s.canvasDocuments)` gives them both the
 * whole map, whose identity changes on every keystroke — so typing re-rendered
 * the entire panel subtree (Monaco wrapper, side panels, outline, review view)
 * once per character.
 *
 * This hook returns only the fields a list actually renders, compared shallowly,
 * with each summary memoised against its source document's object identity. A
 * keystroke changes one document, so exactly one summary changes identity and
 * `useShallow` bails the render for everything else.
 *
 * It is also the workspace-isolation seam for every Canvas *list*. The active
 * project is read reactively (not through `getState()`), so switching workspace
 * re-runs the selector and the rail, the tab strip and the empty state all stop
 * showing the previous workspace's documents in the same commit.
 */

import { useRef } from "react"
import { useShallow } from "zustand/react/shallow"
import {
  filterCanvasDocumentsByWorkspace,
  useArtifactStore,
} from "@/stores/artifact/artifact-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { ArtifactLanguage, CanvasDocument } from "@/types"

export interface CanvasDocumentSummary {
  id: string
  title: string
  language: ArtifactLanguage
  type: CanvasDocument["type"]
  updatedAt: Date
}

function toSummary(doc: CanvasDocument): CanvasDocumentSummary {
  return {
    id: doc.id,
    title: doc.title,
    language: doc.language,
    type: doc.type,
    updatedAt: doc.updatedAt,
  }
}

export function useCanvasDocumentSummaries(): CanvasDocumentSummary[] {
  // Cache keyed by document id, holding the source object it was derived from.
  // Without it every selector run would allocate fresh summaries and
  // `useShallow`'s element-wise compare would fail on identity every time.
  const cacheRef = useRef(
    new Map<string, { source: CanvasDocument; summary: CanvasDocumentSummary }>()
  )
  const projectId = useProjectStore((s) => s.activeProjectId)

  return useArtifactStore(
    useShallow((state) => {
      const cache = cacheRef.current
      const out: CanvasDocumentSummary[] = []
      const seen = new Set<string>()
      const scoped = filterCanvasDocumentsByWorkspace(
        Object.values(state.canvasDocuments) as CanvasDocument[],
        projectId
      )
      for (const doc of scoped) {
        seen.add(doc.id)
        const hit = cache.get(doc.id)
        if (hit && hit.source === doc) {
          out.push(hit.summary)
          continue
        }
        const summary = toSummary(doc)
        cache.set(doc.id, { source: doc, summary })
        out.push(summary)
      }
      for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id)
      return out
    })
  )
}
