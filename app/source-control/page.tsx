"use client"

/**
 * Dedicated full-page Source Control route, reached from the guild-rail
 * "Source Control" entry.
 *
 * Thin by design: the route owns which body to mount and which repository the
 * panel is bound to, and nothing else. The desktop panel carries its own chrome
 * and a resizable two-pane split, which is not a layout at 375px but two
 * unusable columns, so the compact branch inverts it: the change list is the
 * page and the diff arrives as a drawer. Both read the same `useGitStore` and
 * drive the same `useGitActions`.
 *
 * `?root=` names a repository or worktree to bind to, which is how a ⌘K row
 * for a branch held in another worktree lands on that worktree rather than on
 * whichever tree the panel happened to be showing. Read once per value, not on
 * every render: after the first bind the panel owns its own root, and a user
 * who then switches roots by hand must not be dragged back by a stale URL.
 *
 * `?path=` (with `?staged=1` for the index side) names a file to select, and
 * is applied AFTER the root: binding a different repository clears the
 * selection, so a surface that selected the file itself and then navigated
 * lost it whenever the roots differed. On a phone the file's drawer opens,
 * since there the selection alone shows nothing.
 *
 * Static export note: `useSearchParams()` opts out of static rendering, so the
 * reader sits inside `<Suspense>`. Same idiom as `app/workspace/page.tsx`.
 */

import { Suspense, useEffect, useRef } from "react"
import { useSearchParams } from "next/navigation"

import { SourceControlMobileBody } from "@/components/mobile/source-control/source-control-mobile-body"
import { SourceControlPanel } from "@/components/source-control/source-control-panel"
import {
  SOURCE_CONTROL_PATH_PARAM,
  SOURCE_CONTROL_ROOT_PARAM,
  SOURCE_CONTROL_STAGED_PARAM,
} from "@/lib/global-search/providers/git"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import { useGitStore } from "@/stores/git/git-store"

function SourceControlPageInner() {
  const compact = useCompactLayout()
  const searchParams = useSearchParams()
  const requestedRoot = searchParams?.get(SOURCE_CONTROL_ROOT_PARAM) ?? null
  const requestedPath = searchParams?.get(SOURCE_CONTROL_PATH_PARAM) ?? null
  const requestedStaged = searchParams?.get(SOURCE_CONTROL_STAGED_PARAM) === "1"
  const applied = useRef<string | null>(null)
  const appliedSelection = useRef<string | null>(null)

  useEffect(() => {
    const store = useGitStore.getState()
    if (requestedRoot && applied.current !== requestedRoot) {
      applied.current = requestedRoot
      store.setRootDir(requestedRoot)
    }
    // After the root, which clears the selection when it changes repository.
    const selection = requestedPath
      ? `${requestedRoot ?? ""}\u0000${requestedPath}\u0000${requestedStaged}`
      : null
    if (selection && appliedSelection.current !== selection) {
      appliedSelection.current = selection
      store.selectFile(requestedPath, requestedStaged)
    }
  }, [requestedRoot, requestedPath, requestedStaged])

  return compact ? (
    <SourceControlMobileBody initialDiffOpen={requestedPath !== null} />
  ) : (
    <SourceControlPanel />
  )
}

export default function SourceControlPage() {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <Suspense fallback={null}>
        <SourceControlPageInner />
      </Suspense>
    </div>
  )
}
