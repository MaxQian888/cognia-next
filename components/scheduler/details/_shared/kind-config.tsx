/**
 * Shared `kindConfig` mapping for every `ScheduledItemKind` the scheduler
 * surfaces. The sidebar item and the unified detail orchestrator both read
 * from this single source of truth so icons, accent backgrounds, and colors
 * stay aligned without per-component drift.
 *
 * Extracted from `unified-task-sidebar-item.tsx` (where it lived inline).
 */

import React from "react"
import { Calendar, Workflow, Archive, Plug, Cog, Send } from "lucide-react"
import type { ScheduledItemKind } from "@/types/scheduler/unified"

export interface KindConfigEntry {
  icon: React.ReactNode
  bg: string
  color: string
}

export const kindConfig: Record<ScheduledItemKind, KindConfigEntry> = {
  app: {
    icon: <Calendar className="h-3.5 w-3.5" />,
    bg: "bg-indigo-500/10",
    color: "text-indigo-500",
  },
  workflow: {
    icon: <Workflow className="h-3.5 w-3.5" />,
    bg: "bg-violet-500/10",
    color: "text-violet-500",
  },
  backup: {
    icon: <Archive className="h-3.5 w-3.5" />,
    bg: "bg-orange-500/10",
    color: "text-orange-500",
  },
  plugin: {
    icon: <Plug className="h-3.5 w-3.5" />,
    bg: "bg-emerald-500/10",
    color: "text-emerald-500",
  },
  system: {
    icon: <Cog className="h-3.5 w-3.5" />,
    bg: "bg-slate-500/10",
    color: "text-slate-500",
  },
  connector: {
    icon: <Send className="h-3.5 w-3.5" />,
    bg: "bg-cyan-500/10",
    color: "text-cyan-500",
  },
}
