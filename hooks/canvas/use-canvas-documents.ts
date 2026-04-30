"use client"

/**
 * useCanvasDocuments - Hook for managing multiple Canvas documents
 */

import { useCallback, useMemo } from "react"
import { useArtifactStore } from "@/stores"
import type { CanvasDocument, ArtifactLanguage } from "@/types"

export interface CreateDocumentOptions {
  sessionId?: string
  title: string
  content: string
  language: ArtifactLanguage
  type: "code" | "text"
}

interface UseCanvasDocumentsReturn {
  documents: CanvasDocument[]
  activeDocument: CanvasDocument | null
  activeDocumentId: string | null
  documentCount: number
  createDocument: (options: CreateDocumentOptions) => string
  openDocument: (id: string) => void
  closeDocument: (id: string) => void
  deleteDocument: (id: string) => void
  renameDocument: (id: string, title: string) => void
  duplicateDocument: (id: string, copyLabel?: string) => string | null
  getDocumentsBySession: (sessionId: string) => CanvasDocument[]
  searchDocuments: (query: string) => CanvasDocument[]
}

export function useCanvasDocuments(): UseCanvasDocumentsReturn {
  const canvasDocuments = useArtifactStore((state) => state.canvasDocuments)
  const activeCanvasId = useArtifactStore((state) => state.activeCanvasId)
  const createCanvasDocument = useArtifactStore((state) => state.createCanvasDocument)
  const updateCanvasDocument = useArtifactStore((state) => state.updateCanvasDocument)
  const deleteCanvasDocument = useArtifactStore((state) => state.deleteCanvasDocument)
  const setActiveCanvas = useArtifactStore((state) => state.setActiveCanvas)
  const openPanel = useArtifactStore((state) => state.openPanel)

  const documents = useMemo(() => {
    return Object.values(canvasDocuments).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
  }, [canvasDocuments])

  const activeDocument = useMemo(() => {
    return activeCanvasId ? canvasDocuments[activeCanvasId] || null : null
  }, [canvasDocuments, activeCanvasId])

  const createDocument = useCallback(
    (options: CreateDocumentOptions): string => {
      return createCanvasDocument(options)
    },
    [createCanvasDocument]
  )

  const openDocument = useCallback(
    (id: string) => {
      if (canvasDocuments[id]) {
        setActiveCanvas(id)
        openPanel("canvas")
      }
    },
    [canvasDocuments, setActiveCanvas, openPanel]
  )

  const closeDocument = useCallback(
    (id: string) => {
      if (activeCanvasId === id) {
        // Find another document to switch to
        const remainingDocs = documents.filter((d) => d.id !== id)
        if (remainingDocs.length > 0) {
          setActiveCanvas(remainingDocs[0].id)
        } else {
          setActiveCanvas(null)
        }
      }
    },
    [activeCanvasId, documents, setActiveCanvas]
  )

  const deleteDocument = useCallback(
    (id: string) => {
      closeDocument(id)
      deleteCanvasDocument(id)
    },
    [closeDocument, deleteCanvasDocument]
  )

  const renameDocument = useCallback(
    (id: string, title: string) => {
      updateCanvasDocument(id, { title })
    },
    [updateCanvasDocument]
  )

  const duplicateDocument = useCallback(
    /**
     * @param copyLabel suffix appended to the duplicate's title. Pass
     *   `t("canvas.copySuffix")` from a component context so the label
     *   matches the active locale. Defaults to `"(Copy)"` when called
     *   outside React (tests, scripts).
     */
    (id: string, copyLabel = "(Copy)"): string | null => {
      const doc = canvasDocuments[id]
      if (!doc) return null

      return createCanvasDocument({
        sessionId: doc.sessionId,
        title: `${doc.title} ${copyLabel}`,
        content: doc.content,
        language: doc.language,
        type: doc.type,
      })
    },
    [canvasDocuments, createCanvasDocument]
  )

  const getDocumentsBySession = useCallback(
    (sessionId: string): CanvasDocument[] => {
      return documents.filter((d) => d.sessionId === sessionId)
    },
    [documents]
  )

  const searchDocuments = useCallback(
    (query: string): CanvasDocument[] => {
      const lowerQuery = query.toLowerCase()
      return documents.filter(
        (d) =>
          d.title.toLowerCase().includes(lowerQuery) ||
          d.content.toLowerCase().includes(lowerQuery) ||
          d.language.toLowerCase().includes(lowerQuery)
      )
    },
    [documents]
  )

  return {
    documents,
    activeDocument,
    activeDocumentId: activeCanvasId,
    documentCount: documents.length,
    createDocument,
    openDocument,
    closeDocument,
    deleteDocument,
    renameDocument,
    duplicateDocument,
    getDocumentsBySession,
    searchDocuments,
  }
}

export default useCanvasDocuments
