/**
 * Chunked Document Store - Efficient runtime cache for large canvas
 * documents (chunk-based slicing to minimize memory usage).
 *
 * Intentionally has NO Zustand `persist` middleware: chunks are derived
 * from the raw `content` field on `CanvasDocument`, which the artifact
 * store persists through Dexie. Re-chunking on session start is cheap
 * (O(n) string scan) and avoids storing the same bytes twice. Do NOT
 * add persistence here without also reconciling the artifact-store
 * source-of-truth contract.
 */

import { create } from "zustand"
import {
  LargeFileOptimizer,
  type ChunkedDocument,
  type DocumentIndex,
} from "@/lib/canvas/large-file-optimizer"

interface ChunkedDocumentState {
  chunkedDocuments: Record<string, ChunkedDocument>
  loadedChunks: Record<string, Set<number>>
  documentIndices: Record<string, DocumentIndex>
  visibleRanges: Record<string, { startLine: number; endLine: number }>

  addChunkedDocument: (id: string, content: string) => ChunkedDocument
  removeChunkedDocument: (id: string) => void
  getDocumentContent: (id: string) => string | null
  loadChunkRange: (docId: string, startLine: number, endLine: number) => string | null
  unloadUnusedChunks: (docId: string, keepRecent: number) => void
  updateVisibleRange: (docId: string, startLine: number, endLine: number) => void
  updateDocument: (id: string, content: string) => ChunkedDocument | null
  getDocumentIndex: (id: string) => DocumentIndex | null
  isLargeDocument: (id: string) => boolean
}

export const selectCanvasChunkingState = (state: ChunkedDocumentState) => ({
  addChunkedDocument: state.addChunkedDocument,
  removeChunkedDocument: state.removeChunkedDocument,
  updateDocument: state.updateDocument,
  chunkedDocuments: state.chunkedDocuments,
})

const optimizer = new LargeFileOptimizer()

export const useChunkedDocumentStore = create<ChunkedDocumentState>()((set, get) => ({
  chunkedDocuments: {},
  loadedChunks: {},
  documentIndices: {},
  visibleRanges: {},

  addChunkedDocument: (id: string, content: string) => {
    const chunked = optimizer.chunkContent(id, content)
    const index = optimizer.buildIncrementalIndex(content)

    set((state) => ({
      chunkedDocuments: { ...state.chunkedDocuments, [id]: chunked },
      loadedChunks: { ...state.loadedChunks, [id]: new Set<number>() },
      documentIndices: { ...state.documentIndices, [id]: index },
    }))

    return chunked
  },

  removeChunkedDocument: (id: string) => {
    set((state) => {
      const { [id]: _doc, ...restDocs } = state.chunkedDocuments
      const { [id]: _chunks, ...restChunks } = state.loadedChunks
      const { [id]: _index, ...restIndices } = state.documentIndices
      const { [id]: _range, ...restRanges } = state.visibleRanges
      return {
        chunkedDocuments: restDocs,
        loadedChunks: restChunks,
        documentIndices: restIndices,
        visibleRanges: restRanges,
      }
    })
  },

  getDocumentContent: (id: string) => {
    const doc = get().chunkedDocuments[id]
    if (!doc) return null
    return optimizer.assembleContent(doc)
  },

  loadChunkRange: (docId: string, startLine: number, endLine: number) => {
    const doc = get().chunkedDocuments[docId]
    if (!doc) return null

    const content = optimizer.getChunkRange(doc, startLine, endLine)

    const startChunk = Math.floor(
      (doc.lineOffsets[Math.max(0, startLine - 1)] || 0) / doc.chunkSize
    )
    const endChunk = Math.floor(
      (doc.lineOffsets[Math.min(endLine, doc.lineCount - 1)] || doc.totalLength) / doc.chunkSize
    )

    set((state) => {
      const loadedSet = new Set(state.loadedChunks[docId] || [])
      for (let i = startChunk; i <= endChunk; i++) {
        loadedSet.add(i)
      }
      return {
        loadedChunks: { ...state.loadedChunks, [docId]: loadedSet },
      }
    })

    return content
  },

  unloadUnusedChunks: (docId: string, keepRecent: number) => {
    const doc = get().chunkedDocuments[docId]
    const visibleRange = get().visibleRanges[docId]
    if (!doc || !visibleRange) return

    const startChunk = Math.floor(
      (doc.lineOffsets[Math.max(0, visibleRange.startLine - keepRecent)] || 0) / doc.chunkSize
    )
    const endChunk = Math.floor(
      (doc.lineOffsets[Math.min(visibleRange.endLine + keepRecent, doc.lineCount - 1)] ||
        doc.totalLength) / doc.chunkSize
    )

    set((state) => {
      const loadedSet = new Set<number>()
      for (let i = startChunk; i <= endChunk && i < doc.chunks.length; i++) {
        loadedSet.add(i)
      }
      return {
        loadedChunks: { ...state.loadedChunks, [docId]: loadedSet },
      }
    })
  },

  updateVisibleRange: (docId: string, startLine: number, endLine: number) => {
    set((state) => ({
      visibleRanges: {
        ...state.visibleRanges,
        [docId]: { startLine, endLine },
      },
    }))
  },

  updateDocument: (id: string, content: string) => {
    const existing = get().chunkedDocuments[id]
    if (!existing) return null
    if (optimizer.assembleContent(existing) === content) {
      return existing
    }

    const { newDocument } = optimizer.computeChunkDiff(existing, content)
    const index = optimizer.buildIncrementalIndex(content)

    set((state) => ({
      chunkedDocuments: { ...state.chunkedDocuments, [id]: newDocument },
      documentIndices: { ...state.documentIndices, [id]: index },
    }))

    return newDocument
  },

  getDocumentIndex: (id: string) => {
    return get().documentIndices[id] || null
  },

  isLargeDocument: (id: string) => {
    const doc = get().chunkedDocuments[id]
    return doc ? doc.totalLength > 50000 : false
  },
}))

export default useChunkedDocumentStore
