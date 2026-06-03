"use client"

/**
 * Timeline Sheet: repo-wide or per-file commit history. Selecting a commit sets
 * the store's `selectedCommit`, which the panel renders as a CommitDetail.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ListIcon, NetworkIcon } from "lucide-react"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { ScrollArea } from "@/components/ui/scroll-area"
import { gitFileHistory, gitLog, gitRefs } from "@/lib/git/commands"
import { useGitStore, type TimelineScope } from "@/stores/git/git-store"
import { cn } from "@/lib/utils"
import type { GitRef } from "@/types/git"
import { CommitGraphView } from "./commit-graph-view"

const PAGE = 50

type TimelineViewMode = "list" | "graph"

interface TimelineViewProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rootDir: string
  /** When set, the "This File" tab is available and pre-selected. */
  filePath: string | null
}

export function TimelineView({ open, onOpenChange, rootDir, filePath }: TimelineViewProps) {
  const t = useTranslations("sourceControl")
  const scope = useGitStore((s) => s.timelineScope)
  const setScope = useGitStore((s) => s.setTimelineScope)
  const repoCommits = useGitStore((s) => s.timelineRepo)
  const fileCommits = useGitStore((s) => s.timelineFile)
  const setTimeline = useGitStore((s) => s.setTimeline)
  const selectCommit = useGitStore((s) => s.selectCommit)
  const selectedCommit = useGitStore((s) => s.selectedCommit)

  const [viewMode, setViewMode] = useState<TimelineViewMode>("list")
  const [refs, setRefs] = useState<GitRef[]>([])
  const [loadingMore, setLoadingMore] = useState(false)

  const effectiveScope: TimelineScope = filePath ? scope : "repo"
  // The graph only makes sense for the full repo history; a single file's
  // history is degenerate as a graph, so force the list there.
  const showGraph = viewMode === "graph" && effectiveScope === "repo"

  useEffect(() => {
    if (!open) return
    let alive = true
    if (effectiveScope === "file" && filePath) {
      void gitFileHistory(rootDir, filePath, PAGE).then((c) => alive && setTimeline("file", c))
    } else {
      void gitLog(rootDir, PAGE, 0).then((c) => alive && setTimeline("repo", c))
    }
    return () => {
      alive = false
    }
  }, [open, effectiveScope, rootDir, filePath, setTimeline])

  // Ref decorations for the graph (branch/tag/HEAD badges) — only when shown.
  useEffect(() => {
    if (!open || !showGraph) return
    let alive = true
    void gitRefs(rootDir).then((r) => alive && setRefs(r))
    return () => {
      alive = false
    }
  }, [open, showGraph, rootDir])

  const commits = effectiveScope === "file" ? fileCommits : repoCommits

  // Repo history paginates on demand. A full page back implies more may exist.
  const canLoadMore = effectiveScope === "repo" && commits.length > 0 && commits.length % PAGE === 0

  const loadMore = async () => {
    setLoadingMore(true)
    try {
      const more = await gitLog(rootDir, PAGE, commits.length)
      if (more.length > 0) setTimeline("repo", [...commits, ...more])
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[28rem] flex-col" data-testid="timeline-view">
        <SheetHeader>
          <div className="flex items-center justify-between gap-2">
            <SheetTitle>{t("timeline.title")}</SheetTitle>
            {effectiveScope === "repo" && (
              <div className="flex items-center gap-0.5" data-testid="timeline-view-toggle">
                <Button
                  variant={viewMode === "list" ? "secondary" : "ghost"}
                  size="icon"
                  className="size-7"
                  aria-label={t("timeline.viewList")}
                  aria-pressed={viewMode === "list"}
                  onClick={() => setViewMode("list")}
                  data-testid="timeline-view-list"
                >
                  <ListIcon className="size-3.5" />
                </Button>
                <Button
                  variant={viewMode === "graph" ? "secondary" : "ghost"}
                  size="icon"
                  className="size-7"
                  aria-label={t("timeline.viewGraph")}
                  aria-pressed={viewMode === "graph"}
                  onClick={() => setViewMode("graph")}
                  data-testid="timeline-view-graph"
                >
                  <NetworkIcon className="size-3.5" />
                </Button>
              </div>
            )}
          </div>
        </SheetHeader>

        {filePath && (
          <Tabs
            value={effectiveScope}
            onValueChange={(v) => setScope(v as TimelineScope)}
            className="px-4"
          >
            <TabsList>
              <TabsTrigger value="repo" data-testid="timeline-tab-repo">
                {t("timeline.repository")}
              </TabsTrigger>
              <TabsTrigger value="file" data-testid="timeline-tab-file">
                {t("timeline.thisFile")}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}

        <ScrollArea className="mt-2 min-h-0 flex-1">
          {showGraph ? (
            <CommitGraphView
              commits={commits}
              refs={refs}
              selectedCommit={selectedCommit}
              onSelect={selectCommit}
            />
          ) : (
            <ul className="flex flex-col p-2">
              {commits.map((c) => (
                <li key={c.hash}>
                  <button
                    type="button"
                    onClick={() => selectCommit(c.hash)}
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left hover:bg-accent",
                      selectedCommit === c.hash && "bg-accent"
                    )}
                    data-testid={`timeline-commit-${c.hash}`}
                  >
                    <span className="line-clamp-1 text-sm">{c.summary}</span>
                    <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="font-mono">{c.shortHash}</span>
                      <span>{c.authorName}</span>
                    </span>
                  </button>
                </li>
              ))}
              {commits.length === 0 && (
                <li className="px-2 py-3 text-sm text-muted-foreground">{t("timeline.empty")}</li>
              )}
            </ul>
          )}
          {canLoadMore && (
            <div className="p-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-full"
                disabled={loadingMore}
                onClick={() => void loadMore()}
                data-testid="timeline-load-more"
              >
                {loadingMore ? <Spinner className="size-3.5" /> : t("timeline.loadMore")}
              </Button>
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
