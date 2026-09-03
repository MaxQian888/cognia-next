"use client"

/**
 * Compare-refs Sheet: pick a base and a target ref, list the files changed
 * between them (three-dot / merge-base semantics, like a PR diff), and render
 * the selected file's diff in the shared DiffViewer.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { gitDiffRefsFile, gitDiffRefsFiles, gitRefs } from "@/lib/git/commands"
import { cn } from "@/lib/utils"
import type { GitDiff, GitFileChange, GitRef } from "@/types/git"
import { DiffViewer } from "./diff-viewer"
import { GitRefSelect } from "./git-ref-select"
import { splitPath, statusDecoration } from "./status-decoration"

interface CompareRefsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rootDir: string
}

export function CompareRefsSheet({ open, onOpenChange, rootDir }: CompareRefsSheetProps) {
  const t = useTranslations("sourceControl")
  const [refs, setRefs] = useState<GitRef[]>([])
  const [base, setBase] = useState<string | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const [files, setFiles] = useState<GitFileChange[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<GitDiff | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    void gitRefs(rootDir).then((r) => alive && setRefs(r))
    return () => {
      alive = false
    }
  }, [open, rootDir])

  useEffect(() => {
    if (!open || !base || !target) return
    let alive = true
    void gitDiffRefsFiles(rootDir, base, target).then((f) => {
      if (!alive) return
      setFiles(f)
      setSelected(null)
      setDiff(null)
    })
    return () => {
      alive = false
    }
  }, [open, rootDir, base, target])

  useEffect(() => {
    if (!open || !base || !target || !selected) return
    let alive = true
    void gitDiffRefsFile(rootDir, base, target, selected).then((d) => alive && setDiff(d))
    return () => {
      alive = false
    }
  }, [open, rootDir, base, target, selected])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col sm:max-w-3xl"
        data-testid="compare-refs-sheet"
      >
        <SheetHeader>
          <SheetTitle>{t("compare.title")}</SheetTitle>
        </SheetHeader>

        <div className="flex items-center gap-2 px-4">
          <GitRefSelect
            refs={refs}
            value={base}
            onValueChange={setBase}
            placeholder={t("compare.selectBase")}
            ariaLabel={t("compare.selectBase")}
            testId="compare-base"
            className="h-8 flex-1 text-xs"
          />
          <span className="shrink-0 text-xs text-muted-foreground">…</span>
          <GitRefSelect
            refs={refs}
            value={target}
            onValueChange={setTarget}
            placeholder={t("compare.selectTarget")}
            ariaLabel={t("compare.selectTarget")}
            testId="compare-target"
            className="h-8 flex-1 text-xs"
          />
        </div>

        <div className="mt-2 flex min-h-0 flex-1">
          <ScrollArea className="w-56 shrink-0 border-r">
            <ul className="flex flex-col p-1">
              {files.map((f) => {
                const deco = statusDecoration(f.status)
                const { name, dir } = splitPath(f.path)
                return (
                  <li key={f.path}>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setSelected(f.path)}
                      className={cn(
                        "h-auto w-full min-w-0 justify-start gap-1.5 rounded px-2 py-1 text-left text-xs font-normal",
                        selected === f.path && "bg-accent"
                      )}
                      data-testid={`compare-file-${f.path}`}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {name}
                        {dir && (
                          <span className="ml-1 text-[10px] text-muted-foreground">{dir}</span>
                        )}
                      </span>
                      <span className={cn("font-mono", deco.colorClass)}>{deco.letter}</span>
                    </Button>
                  </li>
                )
              })}
              {files.length === 0 && (
                <li className="px-2 py-2 text-xs text-muted-foreground" data-testid="compare-empty">
                  {base && target ? t("compare.empty") : t("compare.pickBoth")}
                </li>
              )}
            </ul>
          </ScrollArea>
          <div className="min-h-0 flex-1">
            {diff ? (
              <DiffViewer diff={diff} staged={false} />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {t("compare.selectFile")}
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
