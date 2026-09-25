"use client"

/**
 * Compare-refs Sheet: pick a base and a target ref, list the files changed
 * between them (three-dot / merge-base semantics, like a PR diff), and render
 * the selected file's diff in the shared DiffViewer.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { gitDiffRefsFile, gitDiffRefsFiles, gitRefs } from "@/lib/git/commands"
import { cn } from "@/lib/utils"
import { useGitRead } from "@/hooks/git/use-git-read"
import { DiffLoading, DiffViewer } from "./diff-viewer"
import { ReadError } from "./read-error"
import { GitRefSelect } from "./git-ref-select"
import { splitPath, statusDecoration } from "./status-decoration"

interface CompareRefsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rootDir: string
}

export function CompareRefsSheet({ open, onOpenChange, rootDir }: CompareRefsSheetProps) {
  const t = useTranslations("sourceControl")
  const [base, setBase] = useState<string | null>(null)
  const [target, setTarget] = useState<string | null>(null)

  const refsRead = useGitRead(`${rootDir}\u0000refs`, () => gitRefs(rootDir), { enabled: open })
  const refs = refsRead.data ?? []

  // The pair being compared keys both reads below, so picking a new base or
  // target can never show the previous pair's files or diff.
  const pairKey = base && target ? `${rootDir}\u0000${base}\u0000${target}` : null
  const filesRead = useGitRead(
    pairKey,
    () => (base && target ? gitDiffRefsFiles(rootDir, base, target) : Promise.resolve([])),
    { enabled: open }
  )
  const files = filesRead.data ?? []

  // A selection belongs to the pair it was made in; a new pair starts clear.
  const [selection, setSelection] = useState<{ pair: string; path: string } | null>(null)
  const selected = pairKey && selection?.pair === pairKey ? selection.path : null
  const diffRead = useGitRead(
    pairKey && selected ? `${pairKey}\u0000${selected}` : null,
    () =>
      base && target && selected
        ? gitDiffRefsFile(rootDir, base, target, selected)
        : Promise.resolve(null),
    { enabled: open }
  )
  const diff = diffRead.data ?? null

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

        {refsRead.error ? (
          <ReadError
            message={refsRead.error}
            onRetry={refsRead.retry}
            className="px-4"
            testId="compare-refs-error"
          />
        ) : null}

        {/* Side by side from `sm`; stacked below it, where a 224px file
            column beside the diff left the diff a sliver of a 375px sheet. */}
        <div className="mt-2 flex min-h-0 flex-1 flex-col sm:flex-row">
          <ScrollArea className="max-h-40 shrink-0 border-b sm:max-h-none sm:w-56 sm:border-r sm:border-b-0">
            <ul className="flex flex-col p-1">
              {files.map((f) => {
                const deco = statusDecoration(f.status)
                const { name, dir } = splitPath(f.path)
                return (
                  <li key={f.path}>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => pairKey && setSelection({ pair: pairKey, path: f.path })}
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
              {filesRead.error ? (
                <li>
                  <ReadError
                    message={filesRead.error}
                    onRetry={filesRead.retry}
                    testId="compare-files-error"
                  />
                </li>
              ) : filesRead.loading ? (
                <li
                  role="status"
                  className="px-2 py-2 text-xs text-muted-foreground"
                  data-testid="compare-files-loading"
                >
                  {t("read.loading")}
                </li>
              ) : files.length === 0 ? (
                <li className="px-2 py-2 text-xs text-muted-foreground" data-testid="compare-empty">
                  {base && target ? t("compare.empty") : t("compare.pickBoth")}
                </li>
              ) : null}
            </ul>
          </ScrollArea>
          <div className="min-h-0 flex-1">
            {diffRead.error ? (
              <ReadError
                variant="block"
                message={diffRead.error}
                onRetry={diffRead.retry}
                testId="compare-diff-error"
              />
            ) : diffRead.loading ? (
              <DiffLoading />
            ) : diff ? (
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
