"use client"

/**
 * Commit detail: metadata header + the commit's changed-file list; selecting a
 * file shows its diff (vs first parent) in the Monaco DiffViewer.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ScrollArea } from "@/components/ui/scroll-area"
import { gitCommitFiles, gitDiffCommit } from "@/lib/git/commands"
import { commitDiffKey, type GitCommit, type GitDiff, type GitFileChange } from "@/lib/git/types"
import { useGitStore } from "@/stores/git/git-store"
import { cn } from "@/lib/utils"
import { DiffViewer } from "./diff-viewer"
import { splitPath, statusDecoration } from "./status-decoration"

interface CommitDetailProps {
  rootDir: string
  commit: GitCommit
}

export function CommitDetail({ rootDir, commit }: CommitDetailProps) {
  const t = useTranslations("sourceControl")
  const [files, setFiles] = useState<GitFileChange[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<GitDiff | null>(null)
  const cacheDiff = useGitStore((s) => s.cacheDiff)
  const getCachedDiff = useGitStore((s) => s.getCachedDiff)

  // Reset the selection when the displayed commit changes — done in render via
  // a previous-value guard rather than an effect (react-hooks/set-state-in-effect).
  const commitKey = `${rootDir}\n${commit.hash}`
  const [prevCommitKey, setPrevCommitKey] = useState(commitKey)
  if (prevCommitKey !== commitKey) {
    setPrevCommitKey(commitKey)
    setSelected(null)
  }

  // When the selected file changes, show its cached diff immediately or clear
  // the pane while the diff loads. Also a render-phase reset.
  const selectedKey = selected ? commitDiffKey(commit.hash, selected) : null
  const [prevSelected, setPrevSelected] = useState<string | null>(selected)
  if (prevSelected !== selected) {
    setPrevSelected(selected)
    setDiff(selectedKey ? (getCachedDiff(selectedKey) ?? null) : null)
  }

  useEffect(() => {
    let alive = true
    void gitCommitFiles(rootDir, commit.hash).then((f) => {
      if (alive) setFiles(f)
    })
    return () => {
      alive = false
    }
  }, [rootDir, commit.hash])

  useEffect(() => {
    if (!selected || !selectedKey || getCachedDiff(selectedKey)) return
    let alive = true
    void gitDiffCommit(rootDir, commit.hash, selected).then((d) => {
      if (!alive) return
      cacheDiff(selectedKey, d)
      setDiff(d)
    })
    return () => {
      alive = false
    }
  }, [rootDir, commit.hash, selected, selectedKey, cacheDiff, getCachedDiff])

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="commit-detail">
      <header className="shrink-0 border-b p-3">
        <div className="text-sm font-medium">{commit.summary}</div>
        {commit.body && (
          <pre className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
            {commit.body}
          </pre>
        )}
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="font-mono">{commit.shortHash}</span>
          <span>·</span>
          <span>{commit.authorName}</span>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <ScrollArea className="w-56 shrink-0 border-r">
          <ul className="flex flex-col p-1">
            {files.map((f) => {
              const deco = statusDecoration(f.status)
              const { name, dir } = splitPath(f.path)
              return (
                <li key={f.path}>
                  <button
                    type="button"
                    onClick={() => setSelected(f.path)}
                    className={cn(
                      "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-accent",
                      selected === f.path && "bg-accent"
                    )}
                    data-testid={`commit-file-${f.path}`}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {name}
                      {dir && <span className="ml-1 text-[10px] text-muted-foreground">{dir}</span>}
                    </span>
                    <span className={cn("font-mono", deco.colorClass)}>{deco.letter}</span>
                  </button>
                </li>
              )
            })}
            {files.length === 0 && (
              <li className="px-2 py-2 text-xs text-muted-foreground">{t("timeline.empty")}</li>
            )}
          </ul>
        </ScrollArea>
        <div className="min-h-0 flex-1">
          <DiffViewer diff={diff} staged={false} />
        </div>
      </div>
    </div>
  )
}
