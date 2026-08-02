"use client"

import { create } from "zustand"
import { persist } from "zustand/middleware"

import { persistLocalStorage } from "@/stores/persist-storage"

export type LogWorkspaceView =
  "health" | "logs" | "incidents" | "receipts" | "recovery" | "advanced"
export type LogWorkspaceDensity = "compact" | "comfortable" | "spacious"
export type LogWorkspaceSource = "all" | "desktop" | "mobile"
export type IncidentStateFilter =
  | "all"
  | "detected"
  | "awaitingConsent"
  | "queued"
  | "uploading"
  | "processing"
  | "accepted"
  | "rejected"
  | "cancelled"
  | "deleted"

const DEFAULTS = {
  activeView: "health" as LogWorkspaceView,
  density: "comfortable" as LogWorkspaceDensity,
  navigationWidth: 248,
  detailWidth: 384,
  navigationCollapsed: false,
  activeSource: "all" as LogWorkspaceSource,
  incidentStateFilter: "all" as IncidentStateFilter,
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

interface LogWorkspaceState {
  activeView: LogWorkspaceView
  density: LogWorkspaceDensity
  navigationWidth: number
  detailWidth: number
  navigationCollapsed: boolean
  activeSource: LogWorkspaceSource
  incidentStateFilter: IncidentStateFilter
  setActiveView: (view: LogWorkspaceView) => void
  setDensity: (density: LogWorkspaceDensity) => void
  setNavigationWidth: (width: number) => void
  setDetailWidth: (width: number) => void
  setNavigationCollapsed: (collapsed: boolean) => void
  setActiveSource: (source: LogWorkspaceSource) => void
  setIncidentStateFilter: (state: IncidentStateFilter) => void
  resetWorkspace: () => void
}

export const useLogWorkspaceStore = create<LogWorkspaceState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setActiveView: (activeView) => set({ activeView }),
      setDensity: (density) => set({ density }),
      setNavigationWidth: (navigationWidth) =>
        set({ navigationWidth: clamp(navigationWidth, 184, 360) }),
      setDetailWidth: (detailWidth) => set({ detailWidth: clamp(detailWidth, 280, 640) }),
      setNavigationCollapsed: (navigationCollapsed) => set({ navigationCollapsed }),
      setActiveSource: (activeSource) => set({ activeSource }),
      setIncidentStateFilter: (incidentStateFilter) => set({ incidentStateFilter }),
      resetWorkspace: () => set(DEFAULTS),
    }),
    {
      name: "cognia-log-workspace-v1",
      storage: persistLocalStorage(),
    }
  )
)
