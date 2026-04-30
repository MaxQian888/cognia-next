/**
 * useArtifactList - State management hook for artifact list component
 * Extracted from artifact-list.tsx to separate state logic from UI.
 *
 * cognia-next adapts the upstream hook by reading the active session id
 * from `useChatStore` (cognia-next has no `useSessionStore`).
 */

"use client"

import { useState, useMemo, useCallback, useEffect } from "react"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useChatStore } from "@/stores/chat"
import { revealArtifactInWorkspace } from "@/lib/artifacts"
import type { Artifact, ArtifactType, ArtifactRuntimeHealth } from "@/types"

interface UseArtifactListOptions {
  sessionId?: string
  onArtifactClick?: (artifact: Artifact) => void
}

export function useArtifactList({ sessionId, onArtifactClick }: UseArtifactListOptions) {
  const activeArtifactId = useArtifactStore((state) => state.activeArtifactId)
  const deleteArtifact = useArtifactStore((state) => state.deleteArtifact)
  const deleteArtifacts = useArtifactStore((state) => state.deleteArtifacts)
  const artifactWorkspace = useArtifactStore((state) => state.artifactWorkspace)
  const setArtifactWorkspaceFilters = useArtifactStore((state) => state.setArtifactWorkspaceFilters)
  const setArtifactWorkspaceScope = useArtifactStore((state) => state.setArtifactWorkspaceScope)
  const getArtifactsForWorkspace = useArtifactStore((state) => state.getArtifactsForWorkspace)
  const activeChatSessionId = useChatStore((state) => state.activeSessionId)

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [batchMode, setBatchMode] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<string | string[] | null>(null)

  const currentSessionId = sessionId || activeChatSessionId || undefined

  useEffect(() => {
    if (currentSessionId && artifactWorkspace.scope === "session") {
      setArtifactWorkspaceScope("session", currentSessionId)
    }
  }, [artifactWorkspace.scope, currentSessionId, setArtifactWorkspaceScope])

  const sessionArtifacts = useMemo(() => {
    if (!currentSessionId) return []

    return getArtifactsForWorkspace({ sessionId: currentSessionId })
  }, [currentSessionId, getArtifactsForWorkspace])

  const setSearchQuery = useCallback(
    (searchQuery: string) => {
      setArtifactWorkspaceFilters({ searchQuery })
    },
    [setArtifactWorkspaceFilters]
  )

  const setTypeFilter = useCallback(
    (typeFilter: string) => {
      setArtifactWorkspaceFilters({ typeFilter: typeFilter as ArtifactType | "all" })
    },
    [setArtifactWorkspaceFilters]
  )

  const setRuntimeFilter = useCallback(
    (runtimeFilter: string) => {
      setArtifactWorkspaceFilters({
        runtimeFilter: runtimeFilter as ArtifactRuntimeHealth | "all",
      })
    },
    [setArtifactWorkspaceFilters]
  )

  const handleArtifactClick = useCallback(
    (artifact: Artifact) => {
      if (batchMode) {
        setSelectedIds((prev) => {
          const next = new Set(prev)
          if (next.has(artifact.id)) {
            next.delete(artifact.id)
          } else {
            next.add(artifact.id)
          }
          return next
        })
        return
      }
      revealArtifactInWorkspace(artifact.id)
      onArtifactClick?.(artifact)
    },
    [batchMode, onArtifactClick]
  )

  const handleDelete = useCallback((artifactId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setPendingDelete(artifactId)
  }, [])

  const handleBatchDelete = useCallback(() => {
    if (selectedIds.size > 0) {
      setPendingDelete(Array.from(selectedIds))
    }
  }, [selectedIds])

  const confirmDelete = useCallback(() => {
    if (!pendingDelete) return
    if (Array.isArray(pendingDelete)) {
      deleteArtifacts(pendingDelete)
      setSelectedIds(new Set())
      setBatchMode(false)
    } else {
      deleteArtifact(pendingDelete)
    }
    setPendingDelete(null)
  }, [pendingDelete, deleteArtifact, deleteArtifacts])

  const toggleBatchMode = useCallback(() => {
    setBatchMode((prev) => !prev)
    setSelectedIds(new Set())
  }, [])

  return {
    // State
    activeArtifactId,
    searchQuery: artifactWorkspace.searchQuery,
    typeFilter: artifactWorkspace.typeFilter,
    runtimeFilter: artifactWorkspace.runtimeFilter,
    selectedIds,
    batchMode,
    pendingDelete,
    sessionArtifacts,
    // Actions
    setSearchQuery,
    setTypeFilter,
    setPendingDelete,
    toggleBatchMode,
    handleArtifactClick,
    handleDelete,
    handleBatchDelete,
    confirmDelete,
    setRuntimeFilter,
  }
}
