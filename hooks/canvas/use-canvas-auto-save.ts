"use client"

/**
 * useCanvasAutoSave - Manages auto-save timer and unsaved changes tracking for Canvas
 */

import { useCallback, useEffect, useRef, useState } from "react"

export interface UseCanvasAutoSaveOptions {
  documentId: string | null
  content: string
  savedContent?: string
  onSave: (documentId: string, description?: string, isAutoSave?: boolean) => void
  onContentUpdate: (documentId: string, content: string) => void
  autoSaveDelay?: number
}

export interface UseCanvasAutoSaveReturn {
  localContent: string
  setLocalContent: (content: string) => void
  hasUnsavedChanges: boolean
  handleEditorChange: (value: string | undefined) => void
  handleManualSave: () => void
  discardChanges: () => void
  lastSavedContentRef: React.MutableRefObject<string>
}

export function useCanvasAutoSave({
  documentId,
  content,
  savedContent,
  onSave,
  onContentUpdate,
  autoSaveDelay = 30000,
}: UseCanvasAutoSaveOptions): UseCanvasAutoSaveReturn {
  const [localContent, setLocalContentState] = useState("")
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null)
  const lastSavedContentRef = useRef<string>("")

  const clearAutoSaveTimer = useCallback(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
    }
  }, [])

  const setLocalContent = useCallback((nextContent: string) => {
    setLocalContentState(nextContent)
    setHasUnsavedChanges(nextContent !== lastSavedContentRef.current)
  }, [])

  // Sync local content when document changes
  useEffect(() => {
    // Clear pending auto-save from previous document to prevent stale saves
    clearAutoSaveTimer()

    if (content !== undefined) {
      const savedBaseline = savedContent ?? content
      // Use microtask to avoid synchronous setState in effect
      queueMicrotask(() => {
        setLocalContentState(content)
        lastSavedContentRef.current = savedBaseline
        setHasUnsavedChanges(content !== savedBaseline)
      })
    }
  }, [documentId, content, savedContent, clearAutoSaveTimer])

  // Cleanup auto-save timer on unmount
  useEffect(() => {
    return () => {
      clearAutoSaveTimer()
    }
  }, [clearAutoSaveTimer])

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      const newValue = value || ""
      setLocalContentState(newValue)
      if (documentId) {
        onContentUpdate(documentId, newValue)
      }

      setHasUnsavedChanges(newValue !== lastSavedContentRef.current)

      // Auto-save after delay of inactivity if there are changes
      clearAutoSaveTimer()

      if (newValue !== lastSavedContentRef.current && documentId) {
        autoSaveTimerRef.current = setTimeout(() => {
          onSave(documentId, undefined, true)
          lastSavedContentRef.current = newValue
          setHasUnsavedChanges(false)
          autoSaveTimerRef.current = null
        }, autoSaveDelay)
      }
    },
    [documentId, onContentUpdate, onSave, autoSaveDelay, clearAutoSaveTimer]
  )

  const handleManualSave = useCallback(() => {
    if (documentId && hasUnsavedChanges) {
      clearAutoSaveTimer()
      onSave(documentId, undefined, false)
      lastSavedContentRef.current = localContent
      setHasUnsavedChanges(false)
    }
  }, [documentId, hasUnsavedChanges, localContent, onSave, clearAutoSaveTimer])

  const discardChanges = useCallback(() => {
    clearAutoSaveTimer()

    const lastSaved = lastSavedContentRef.current
    setLocalContentState(lastSaved)
    setHasUnsavedChanges(false)

    if (documentId) {
      onContentUpdate(documentId, lastSaved)
    }
  }, [documentId, onContentUpdate, clearAutoSaveTimer])

  return {
    localContent,
    setLocalContent,
    hasUnsavedChanges,
    handleEditorChange,
    handleManualSave,
    discardChanges,
    lastSavedContentRef,
  }
}

export default useCanvasAutoSave
