"use client"

/**
 * `/workspace`, an overview of the active workspace (the repo's `Project`
 * entity, user-facing label "Workspace").
 *
 * Read-and-navigate only: workspace roots keep exactly one editor
 * (`components/shell/workspace-manage-dialog.tsx`), which this page links to.
 *
 * The open tab lives in `?tab=`, not in `useState`, for the reason `/squads`
 * wrote down next door: `FeaturePageShell` renders its children through two
 * different trees, a resizable pane set and a narrow single column, and moving
 * between them REMOUNTS the subtree, so a tab held in component state silently
 * snaps back to Overview the first time the breakpoint resolves. It also makes
 * the Environments tab linkable, which is what lets the phone's Source Control
 * screen point at the worktrees it deliberately does not render itself.
 *
 * Static export note: `useSearchParams()` opts out of static rendering, so the
 * reader sits inside `<Suspense>`. Same idiom as `app/squads/page.tsx`.
 */

import { Suspense, useCallback } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

import {
  WorkspaceOverview,
  WORKSPACE_TABS,
  type WorkspaceTab,
} from "@/components/workspace/workspace-overview"

function WorkspacePageInner() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const raw = searchParams?.get("tab") ?? null
  const tab: WorkspaceTab =
    raw && (WORKSPACE_TABS as readonly string[]).includes(raw) ? (raw as WorkspaceTab) : "overview"

  const setTab = useCallback(
    (next: WorkspaceTab) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "")
      // `overview` is the landing tab, so naming it in the URL would be noise.
      if (next === "overview") params.delete("tab")
      else params.set("tab", next)
      const query = params.toString()
      // `replace` and no scroll: a tab is not a place in history worth stepping
      // back through, and the page must not jump when it changes.
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [router, pathname, searchParams]
  )

  return <WorkspaceOverview tab={tab} onTabChange={setTab} />
}

export default function WorkspacePage() {
  return (
    // `data-bg-target="chat"` is what opts a route's subtree into the wallpaper
    // layer (`app/globals.css`). Every peer console carries it and this page did
    // not, so a user with a background set saw it everywhere except here. Its
    // own test has been asserting this all along.
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col" data-bg-target="chat">
      <Suspense fallback={null}>
        <WorkspacePageInner />
      </Suspense>
    </div>
  )
}
