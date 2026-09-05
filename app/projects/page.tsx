"use client"

/**
 * `/projects` — the tracker's delivery containers (`IssueProject`).
 *
 * NOT the repo's `Project` (workspace) entity, which lives at `/workspace`.
 * Deep links use `?id=` inside `<Suspense>`: this app is a static export, so
 * `[id]` segments do not exist at runtime.
 *
 * A narrow viewport gets its own read-only body, mirroring `/issues`. Without
 * the branch the desktop table renders inside `FeaturePageShellMobile`, which
 * is a seven-column grid in a 375px viewport. Keyed on width rather than on
 * the Capacitor runtime, so a narrow browser is covered as well.
 *
 * `?tab=cycles` is the tracker's third destination (cycles and milestones).
 * It lives under `/projects` rather than at its own route because the static
 * export gains a page per route and the two are one planning surface.
 */

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"

import { CycleConsole } from "@/components/issues/cycles/cycle-console"
import { ProjectConsole } from "@/components/issues/projects/project-console"
import { CyclesMobileBody } from "@/components/mobile/issues/cycles-mobile-body"
import { ProjectsMobileBody } from "@/components/mobile/issues/projects-mobile-body"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"

function ProjectsPageInner() {
  const params = useSearchParams()
  const compact = useCompactLayout()
  const initialSelectedId = params.get("id") ?? undefined
  const tab = params.get("tab") === "cycles" ? "cycles" : "projects"

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      {tab === "cycles" ? (
        compact ? (
          <CyclesMobileBody />
        ) : (
          <CycleConsole />
        )
      ) : compact ? (
        <ProjectsMobileBody initialSelectedId={initialSelectedId} />
      ) : (
        <ProjectConsole initialSelectedId={initialSelectedId} />
      )}
    </div>
  )
}

export default function ProjectsPage() {
  return (
    <Suspense fallback={null}>
      <ProjectsPageInner />
    </Suspense>
  )
}
