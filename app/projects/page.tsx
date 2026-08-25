"use client"

/**
 * `/projects` — the tracker's delivery containers (`IssueProject`).
 *
 * NOT the repo's `Project` (workspace) entity, which lives at `/workspace`.
 * Deep links use `?id=` inside `<Suspense>`: this app is a static export, so
 * `[id]` segments do not exist at runtime.
 *
 * Mobile gets its own read-only body, mirroring `/issues`. Without the branch
 * the phone rendered the desktop table inside `FeaturePageShellMobile` — a
 * seven-column grid in a 375px viewport.
 */

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"

import { ProjectsMobileBody } from "@/components/mobile/issues/projects-mobile-body"
import { ProjectConsole } from "@/components/issues/projects/project-console"
import { usePlatform } from "@/hooks/use-platform"

function ProjectsPageInner() {
  const params = useSearchParams()
  const platform = usePlatform()
  const initialSelectedId = params.get("id") ?? undefined

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      {platform === "mobile" ? (
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
