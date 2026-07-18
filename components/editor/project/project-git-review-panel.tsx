"use client"

import { useMemo } from "react"
import { DiffPane } from "@/components/source-control/diff-pane"
import { gitDiscard, gitStage, gitUnstage } from "@/lib/git/commands"

export function ProjectGitReviewPanel({
  rootPath,
  relPath,
}: {
  rootPath: string
  relPath: string
}) {
  const actions = useMemo(
    () => ({
      stage: (paths: string[], patch?: string) => gitStage(rootPath, paths, patch),
      unstage: (paths: string[], patch?: string) => gitUnstage(rootPath, paths, patch),
      discard: (paths: string[], patch?: string) => gitDiscard(rootPath, paths, patch),
    }),
    [rootPath]
  )
  return (
    <DiffPane
      rootDir={rootPath}
      path={relPath}
      staged={false}
      actions={actions}
      density="compact"
    />
  )
}
