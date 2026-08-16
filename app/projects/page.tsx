"use client"

/**
 * `/projects` — the tracker's delivery containers (`IssueProject`).
 *
 * NOT the repo's `Project` (workspace) entity, which lives at `/workspace`.
 * Deep links use `?id=` inside `<Suspense>`: this app is a static export, so
 * `[id]` segments do not exist at runtime.
 */

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"

import { ProjectConsole } from "@/components/issues/project-console"

function ProjectsPageInner() {
  const params = useSearchParams()
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col" data-bg-target="chat">
      <ProjectConsole initialSelectedId={params.get("id") ?? undefined} />
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
