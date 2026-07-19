"use client"

/**
 * A2UI Workspace Context
 * Ephemeral workspace state - not persisted to store
 */

import React, { createContext, useCallback, useContext, useState, useMemo } from "react"

export type WorkspaceMode = "edit" | "preview" | "data"

export const MIN_WORKSPACE_ZOOM = 50
export const MAX_WORKSPACE_ZOOM = 200
export const WORKSPACE_ZOOM_STEP = 25

interface A2UIWorkspaceContextValue {
  surfaceId: string
  selectedComponentId: string | null
  setSelectedComponentId: (id: string | null) => void
  workspaceMode: WorkspaceMode
  setWorkspaceMode: (mode: WorkspaceMode) => void
  zoom: number
  setZoom: (zoom: number) => void
  showTree: boolean
  setShowTree: (show: boolean) => void
  showProperties: boolean
  setShowProperties: (show: boolean) => void
}

const WorkspaceContext = createContext<A2UIWorkspaceContextValue | null>(null)

interface A2UIWorkspaceProviderProps {
  surfaceId: string
  children: React.ReactNode
}

export function A2UIWorkspaceProvider({ surfaceId, children }: A2UIWorkspaceProviderProps) {
  const [selectedComponentId, setSelectedComponentId] = useState<string | null>(null)
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("edit")
  const [zoom, setZoomState] = useState(100)
  const [showTree, setShowTree] = useState(true)
  const [showProperties, setShowProperties] = useState(true)
  const setZoom = useCallback((nextZoom: number) => {
    setZoomState(Math.min(MAX_WORKSPACE_ZOOM, Math.max(MIN_WORKSPACE_ZOOM, nextZoom)))
  }, [])

  const value = useMemo(
    () => ({
      surfaceId,
      selectedComponentId,
      setSelectedComponentId,
      workspaceMode,
      setWorkspaceMode,
      zoom,
      setZoom,
      showTree,
      setShowTree,
      showProperties,
      setShowProperties,
    }),
    [surfaceId, selectedComponentId, workspaceMode, zoom, setZoom, showTree, showProperties]
  )

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspaceContext() {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error("useWorkspaceContext must be used within A2UIWorkspaceProvider")
  return ctx
}
