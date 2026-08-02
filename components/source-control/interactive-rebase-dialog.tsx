"use client"

/**
 * InteractiveRebaseDialog — a GitLens-style interactive-rebase planner. Lists
 * the commits in `base..HEAD` (oldest first) with a per-row action
 * (pick/reword/squash/fixup/drop) and up/down reordering. `reword` reveals an
 * inline message field (collected up-front; the backend feeds it via a queued
 * GIT_EDITOR). Apply runs `git rebase -i` with the assembled plan; a conflict
 * leaves the rebase in progress and the panel's in-progress banner takes over.
 *
 * Keyed by `base` in the panel, so it mounts fresh per base — no in-effect
 * state reset (which would trip set-state-in-effect).
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { gitRebaseCommits } from "@/lib/git/commands"
import type { RebaseAction, RebaseTodoEntry } from "@/types/git"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"

interface Row {
  sha: string
  shortHash: string
  summary: string
  action: RebaseAction
  message: string
}

const ACTIONS: RebaseAction[] = ["pick", "reword", "squash", "fixup", "drop"]

interface InteractiveRebaseDialogProps {
  rootDir: string
  /** Rebase commits in `base..HEAD`; `null` keeps the dialog closed. */
  base: string | null
  onOpenChange: (open: boolean) => void
  actions: Pick<UseGitActionsResult, "interactiveRebase">
}

export function InteractiveRebaseDialog({
  rootDir,
  base,
  onOpenChange,
  actions,
}: InteractiveRebaseDialogProps) {
  const t = useTranslations("sourceControl")
  const [rows, setRows] = useState<Row[] | null>(null)

  useEffect(() => {
    if (base === null) return
    let alive = true
    void gitRebaseCommits(rootDir, base).then((commits) => {
      if (!alive) return
      setRows(
        commits.map((c) => ({
          sha: c.hash,
          shortHash: c.shortHash,
          summary: c.summary,
          action: "pick" as RebaseAction,
          message: c.summary,
        }))
      )
    })
    return () => {
      alive = false
    }
  }, [base, rootDir])

  const update = (i: number, patch: Partial<Row>) =>
    setRows((prev) => prev?.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) ?? prev)

  const move = (i: number, dir: -1 | 1) =>
    setRows((prev) => {
      if (!prev) return prev
      const j = i + dir
      if (j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })

  const apply = async () => {
    if (!rows || base === null) return
    const entries: RebaseTodoEntry[] = rows.map((r) => ({
      sha: r.sha,
      action: r.action,
      message: r.action === "reword" ? r.message : undefined,
    }))
    const failure = await actions.interactiveRebase(base, entries)
    if (failure) return
    onOpenChange(false)
  }

  const allDropped = rows?.every((r) => r.action === "drop") ?? false

  return (
    <Dialog open={base !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="interactive-rebase-dialog">
        <DialogHeader>
          <DialogTitle>{t("irebase.title")}</DialogTitle>
          <DialogDescription>{t("irebase.description")}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-96">
          <ul className="flex flex-col gap-1 pr-2">
            {rows?.map((row, i) => (
              <li
                key={row.sha}
                className="flex flex-col gap-1 rounded border p-2"
                data-testid={`irebase-row-${row.sha}`}
              >
                <div className="flex items-center gap-2">
                  <div className="flex flex-col">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-4"
                      disabled={i === 0}
                      aria-label={t("irebase.moveUp")}
                      onClick={() => move(i, -1)}
                      data-testid={`irebase-up-${row.sha}`}
                    >
                      <ChevronUpIcon className="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-4"
                      disabled={i === (rows?.length ?? 0) - 1}
                      aria-label={t("irebase.moveDown")}
                      onClick={() => move(i, 1)}
                      data-testid={`irebase-down-${row.sha}`}
                    >
                      <ChevronDownIcon className="size-3" />
                    </Button>
                  </div>
                  <Select
                    value={row.action}
                    onValueChange={(v) => update(i, { action: v as RebaseAction })}
                  >
                    <SelectTrigger
                      className="h-7 w-28 text-xs"
                      data-testid={`irebase-action-${row.sha}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ACTIONS.map((a) => (
                        <SelectItem key={a} value={a} className="text-xs">
                          {t(`irebase.action.${a}` as never)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {row.shortHash}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs">{row.summary}</span>
                </div>
                {row.action === "reword" && (
                  <Input
                    value={row.message}
                    onChange={(e) => update(i, { message: e.target.value })}
                    placeholder={t("irebase.rewordPlaceholder")}
                    className="h-7 text-xs"
                    data-testid={`irebase-message-${row.sha}`}
                  />
                )}
              </li>
            ))}
            {rows?.length === 0 && (
              <li className="px-2 py-3 text-sm text-muted-foreground">{t("irebase.empty")}</li>
            )}
          </ul>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("irebase.cancel")}
          </Button>
          <Button
            onClick={() => void apply()}
            disabled={!rows || rows.length === 0 || allDropped}
            data-testid="irebase-apply"
          >
            {t("irebase.apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
