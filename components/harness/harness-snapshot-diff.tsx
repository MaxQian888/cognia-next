"use client"

/**
 * File-by-file difference between two harnesses, rendered from their editable
 * trees (the same files the editors edit), so what a person reviews is
 * exactly what an editor changed.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { LineDiffView } from "@/components/diff/line-diff-view"
import { Badge } from "@/components/ui/badge"
import { computeDiff } from "@/lib/artifacts/diff"
import { componentsToTree, diffTrees } from "@/lib/harness/tree"
import type { HarnessComponentsV1 } from "@/types/harness/snapshot"

export interface HarnessSnapshotDiffProps {
  before: HarnessComponentsV1
  after: HarnessComponentsV1
  /** Cap each file's diff box, so a long prompt does not push the rest away. */
  maxHeight?: number
}

type Change = "added" | "removed" | "modified"

export function HarnessSnapshotDiff({ before, after, maxHeight = 360 }: HarnessSnapshotDiffProps) {
  const t = useTranslations("harnessEvolution.diff")
  const files = useMemo(() => {
    const a = componentsToTree(before)
    const b = componentsToTree(after)
    const summary = diffTrees(a, b)
    const rows: { path: string; change: Change }[] = [
      ...summary.modified.map((path) => ({ path, change: "modified" as const })),
      ...summary.added.map((path) => ({ path, change: "added" as const })),
      ...summary.removed.map((path) => ({ path, change: "removed" as const })),
    ].sort((x, y) => x.path.localeCompare(y.path))
    return rows.map((row) => ({ ...row, lines: computeDiff(a[row.path] ?? "", b[row.path] ?? "") }))
  }, [before, after])

  if (files.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="harness-diff-empty">
        {t("none")}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-3" data-testid="harness-diff">
      {files.map((file) => (
        <section key={file.path} className="overflow-hidden rounded-md border">
          <header className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-1.5">
            <code className="truncate text-xs">{file.path}</code>
            <Badge
              variant={
                file.change === "added"
                  ? "success"
                  : file.change === "removed"
                    ? "destructive"
                    : "secondary"
              }
            >
              {t(`change.${file.change}`)}
            </Badge>
          </header>
          <LineDiffView
            lines={file.lines}
            maxHeight={maxHeight}
            wrap
            aria-label={t("fileLabel", { path: file.path })}
            data-testid={`harness-diff-${file.path}`}
          />
        </section>
      ))}
    </div>
  )
}
