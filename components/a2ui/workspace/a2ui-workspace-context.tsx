"use client"

/**
 * A2UI Workspace Context
 * Ephemeral workspace state - not persisted to store
 */

import React, { createContext, useContext, useState, useMemo } from "react"

export type WorkspaceMode = "edit" | "preview" | "data"

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
  const [zoom, setZoom] = useState(100)
  const [showTree, setShowTree] = useState(true)
  const [showProperties, setShowProperties] = useState(true)

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
    [surfaceId, selectedComponentId, workspaceMode, zoom, showTree, showProperties]
  )

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspaceContext() {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error("useWorkspaceContext must be used within A2UIWorkspaceProvider")
  return ctx
}
