"use client"

/**
 * Timeline Sheet: repo-wide or per-file commit history. Selecting a commit sets
 * the store's `selectedCommit`, which the panel renders as a CommitDetail.
 *
 * The sheet is modal. A commit picked here is rendered by the host OUTSIDE the
 * sheet (the desktop's right pane, the phone's drawer), behind this overlay,
 * so the host passes `onPickCommit` and closes the sheet on a pick; otherwise
 * the detail it opened is dimmed, inert, and gone again on close.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ListIcon, NetworkIcon } from "lucide-react"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { ScrollArea } from "@/components/ui/scroll-area"
import { gitFileHistory, gitLog, gitRefs } from "@/lib/git/commands"
import { useGitStore, type TimelineScope } from "@/stores/git/git-store"
import { useSourceControlPrefs } from "@/hooks/git/use-source-control-prefs"
import { gitErrorDetail } from "@/lib/git/load"
import { useGitRead } from "@/hooks/git/use-git-read"
import { cn } from "@/lib/utils"
import { CommitGraphView } from "./commit-graph-view"
import { ReadError } from "./read-error"

const PAGE = 50

type TimelineViewMode = "list" | "graph"

interface TimelineViewProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rootDir: string
  /** When set, the "This File" tab is available and pre-selected. */
  filePath: string | null
  /**
   * A commit was picked (list row or graph node). The host renders the detail
   * outside this modal sheet, so it closes the sheet here.
   */
  onPickCommit?: (sha: string) => void
  /**
   * Offer the graph view. Off on a phone, where a lane graph has no width to
   * draw in and the list is the readable shape.
   */
  allowGraph?: boolean
}

export function TimelineView({
  open,
  onOpenChange,
  rootDir,
  filePath,
  onPickCommit,
  allowGraph = true,
}: TimelineViewProps) {
  const t = useTranslations("sourceControl")
  const scope = useGitStore((s) => s.timelineScope)
  const setScope = useGitStore((s) => s.setTimelineScope)
  const repoCommits = useGitStore((s) => s.timelineRepo)
  const fileCommits = useGitStore((s) => s.timelineFile)
  const setTimeline = useGitStore((s) => s.setTimeline)
  const selectCommit = useGitStore((s) => s.selectCommit)
  const selectedCommit = useGitStore((s) => s.selectedCommit)
  const { prefs } = useSourceControlPrefs()

  const [viewMode, setViewMode] = useState<TimelineViewMode>(prefs.defaultTimelineView)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)
  const [filter, setFilter] = useState("")

  // Reset to the preferred view each time the Sheet opens (render-phase guard,
  // not a set-state effect) so it always honors the configured default.
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) setViewMode(prefs.defaultTimelineView)
  }

  const effectiveScope: TimelineScope = filePath ? scope : "repo"
  // The graph only makes sense for the full repo history; a single file's
  // history is degenerate as a graph, so force the list there.
  const showGraph = allowGraph && viewMode === "graph" && effectiveScope === "repo"

  // First page of the history in scope. Written through to the store, which
  // the panel reads to give `CommitDetail` a header before its own read lands.
  const history = useGitRead(
    `${rootDir}\u0000${effectiveScope}\u0000${effectiveScope === "file" ? filePath : ""}`,
    async () => {
      if (effectiveScope === "file" && filePath) {
        const commits = await gitFileHistory(rootDir, filePath, PAGE)
        setTimeline("file", commits)
        return commits.length
      }
      const commits = await gitLog(rootDir, PAGE, 0)
      setTimeline("repo", commits)
      return commits.length
    },
    { enabled: open }
  )

  // Ref decorations for the graph (branch/tag/HEAD badges) — only when shown.
  const refsRead = useGitRead(`${rootDir}\u0000refs`, () => gitRefs(rootDir), {
    enabled: open && showGraph,
  })
  const refs = refsRead.data ?? []

  // The store keeps whichever history was read last, which may belong to
  // another file. Until this scope's read has answered, show nothing from it:
  // a pending read says "loading", not someone else's commits.
  const ready = history.data !== undefined
  const storeCommits = effectiveScope === "file" ? fileCommits : repoCommits
  const commits = ready ? storeCommits : []

  // Client-side filter over the loaded pages: summary/body, author, or hash
  // prefix, case-insensitive. Load-more keeps fetching unfiltered pages.
  const query = filter.trim().toLowerCase()
  const visibleCommits = query
    ? commits.filter(
        (c) =>
          c.summary.toLowerCase().includes(query) ||
          c.body.toLowerCase().includes(query) ||
          c.authorName.toLowerCase().includes(query) ||
          c.authorEmail.toLowerCase().includes(query) ||
          c.hash.toLowerCase().startsWith(query)
      )
    : commits

  // Repo history paginates on demand. A full page back implies more may exist.
  const canLoadMore = effectiveScope === "repo" && commits.length > 0 && commits.length % PAGE === 0

  const loadMore = async () => {
    setLoadingMore(true)
    setMoreError(null)
    try {
      const more = await gitLog(rootDir, PAGE, commits.length)
      if (more.length > 0) setTimeline("repo", [...commits, ...more])
    } catch (error) {
      setMoreError(gitErrorDetail(error))
    } finally {
      setLoadingMore(false)
    }
  }

  const pick = (sha: string) => {
    selectCommit(sha)
    onPickCommit?.(sha)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col sm:max-w-md"
        data-testid="timeline-view"
      >
        <SheetHeader>
          <div className="flex items-center justify-between gap-2">
            <SheetTitle>{t("timeline.title")}</SheetTitle>
            {allowGraph && effectiveScope === "repo" && (
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

        {!showGraph && (
          <div className="px-4 pt-2">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("timeline.filterPlaceholder")}
              className="h-7 text-xs"
              data-testid="timeline-filter"
            />
          </div>
        )}

        <ScrollArea className="mt-2 min-h-0 flex-1">
          {history.error ? (
            <ReadError
              message={history.error}
              onRetry={history.retry}
              className="px-4"
              testId="timeline-load-error"
            />
          ) : !ready ? (
            <div
              role="status"
              className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground"
              data-testid="timeline-loading"
            >
              <Spinner className="size-3.5" />
              {t("timeline.loading")}
            </div>
          ) : showGraph ? (
            <>
              {refsRead.error ? (
                <ReadError
                  message={refsRead.error}
                  onRetry={refsRead.retry}
                  testId="timeline-refs-error"
                />
              ) : null}
              <CommitGraphView
                commits={commits}
                refs={refs}
                selectedCommit={selectedCommit}
                onSelect={pick}
              />
            </>
          ) : (
            <ul className="flex flex-col p-2">
              {visibleCommits.map((c) => (
                <li key={c.hash}>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => pick(c.hash)}
                    className={cn(
                      "h-auto w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left font-normal",
                      selectedCommit === c.hash && "bg-accent"
                    )}
                    data-testid={`timeline-commit-${c.hash}`}
                  >
                    <span className="line-clamp-1 text-sm">{c.summary}</span>
                    <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="font-mono">{c.shortHash}</span>
                      <span>{c.authorName}</span>
                    </span>
                  </Button>
                </li>
              ))}
              {visibleCommits.length === 0 && (
                <li className="px-2 py-3 text-sm text-muted-foreground">{t("timeline.empty")}</li>
              )}
            </ul>
          )}
          {moreError ? (
            <ReadError
              message={moreError}
              onRetry={() => void loadMore()}
              testId="timeline-more-error"
            />
          ) : null}
          {ready && canLoadMore && (
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
