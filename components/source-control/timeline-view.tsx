"use client"

/**
 * Timeline Sheet: repo-wide or per-file commit history. Selecting a commit sets
 * the store's `selectedCommit`, which the panel renders as a CommitDetail.
 */

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { gitFileHistory, gitLog } from "@/lib/git/commands"
import { useGitStore, type TimelineScope } from "@/stores/git/git-store"
import { cn } from "@/lib/utils"

const PAGE = 50

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

  const effectiveScope: TimelineScope = filePath ? scope : "repo"

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

  const commits = effectiveScope === "file" ? fileCommits : repoCommits

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[28rem] flex-col" data-testid="timeline-view">
        <SheetHeader>
          <SheetTitle>{t("timeline.title")}</SheetTitle>
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
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
