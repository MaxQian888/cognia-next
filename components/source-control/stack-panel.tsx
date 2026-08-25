"use client"

/**
 * The stacks in this repository, and what is wrong with them.
 *
 * # Why the problems are the content
 *
 * A stack that looks fine and is not is the failure this whole subsystem
 * exists to prevent: a layer that no longer contains its parent still
 * publishes, and its pull request quietly carries the layer below it. So the
 * panel's job is not "list your stacks" — it is to say, per stack, whether it
 * is safe and exactly what to do when it is not. The action button is the
 * remedy the validator chose, not a generic "fix".
 *
 * # No stack table
 *
 * Everything here is read from the parent pointers in the repository's own Git
 * config. A stack created in a terminal, or pulled from another machine, is
 * already here. Recording a parent from this panel writes the same config a
 * `git config` would, which is why the form is the whole "create a stack" flow.
 */

import { useState } from "react"
import { GitBranchIcon, LayersIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { useStacks, type StackRow } from "@/hooks/git/use-stacks"
import { canRestack, type StackProblem } from "@/lib/stack/validate"
import { cn } from "@/lib/utils"
import { asGitError, type GitBranch } from "@/types/git"

interface StackPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rootDir: string
  /** Local branches, for the "record a parent" form. */
  branches: GitBranch[]
  /** Injected in tests; production takes the hook's own defaults. */
  deps?: Parameters<typeof useStacks>[1]
}

function errorDetail(err: unknown): string {
  const payload = asGitError(err)
  if (payload?.detail) return payload.detail
  if (payload?.kind) return payload.kind
  return err instanceof Error ? err.message : String(err)
}

/** The message parameters each problem kind carries. */
function problemValues(problem: StackProblem): Record<string, string> {
  switch (problem.kind) {
    case "missingBranch":
      return { branch: problem.branch }
    case "behindParent":
      return { branch: problem.branch, parent: problem.parent }
    case "parentMismatch":
      return { branch: problem.branch, recorded: problem.recorded, expected: problem.expected }
    case "parentUnrecorded":
      return { branch: problem.branch, expected: problem.expected }
    case "checkedOut":
      return { branch: problem.branch, worktree: problem.worktree }
    case "forkOnly":
      return { repository: problem.repository }
  }
}

function StackCard({
  row,
  busy,
  onRestack,
  onUnstack,
}: {
  row: StackRow
  busy: boolean
  onRestack: () => void
  onUnstack: (branch: string) => void
}) {
  const t = useTranslations("sourceControl.stacks")
  const fixable = canRestack(row.verdict)
  const stateOf = (branch: string) => row.states.find((state) => state.branch === branch)

  return (
    <div
      className="space-y-2 rounded-md border bg-background/40 p-3"
      data-testid={`stack-${row.stack.id}`}
      data-ok={row.verdict.ok ? "true" : "false"}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" />
            {row.stack.layers[row.stack.layers.length - 1]?.branch}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {t("trunk", { branch: row.stack.trunk })} ·{" "}
            {t("layerCount", { count: row.stack.layers.length })}
          </p>
        </div>
        {fixable ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 px-2 text-[11px]"
            disabled={busy}
            onClick={onRestack}
            data-testid={`stack-restack-${row.stack.id}`}
          >
            {busy ? <Spinner className="size-3" /> : null}
            {busy ? t("restacking") : t("restack")}
          </Button>
        ) : null}
      </div>

      <ol className="space-y-1">
        {[...row.stack.layers]
          .sort((left, right) => left.order - right.order)
          .map((layer) => {
            const state = stateOf(layer.branch)
            return (
              <li
                key={layer.branch}
                className="flex items-center justify-between gap-2 rounded bg-background/70 px-2 py-1"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <GitBranchIcon className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono text-[11px]">{layer.branch}</span>
                  {state?.checkedOutIn ? (
                    <Badge variant="secondary" className="shrink-0 text-[9px] font-normal">
                      {t("checkedOutAt", { path: state.checkedOutIn })}
                    </Badge>
                  ) : null}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 shrink-0 px-1.5 text-[10px]"
                  disabled={busy}
                  onClick={() => onUnstack(layer.branch)}
                >
                  {t("unstack")}
                </Button>
              </li>
            )
          })}
      </ol>

      {row.verdict.ok ? (
        <p className="text-[10px] text-muted-foreground">{t("healthy")}</p>
      ) : (
        <div className="space-y-1" data-testid={`stack-problems-${row.stack.id}`}>
          {row.verdict.problems.map((problem, index) => (
            <p
              key={`${problem.kind}-${index}`}
              className="text-[10px] text-amber-600 dark:text-amber-500"
            >
              {t(`problem.${problem.kind}`, problemValues(problem))}
            </p>
          ))}
          <p className="text-[10px] font-medium">{t(`remedy.${row.verdict.remedy}`)}</p>
        </div>
      )}
    </div>
  )
}

export function StackPanel({ open, onOpenChange, rootDir, branches, deps }: StackPanelProps) {
  const t = useTranslations("sourceControl.stacks")
  const { rows, loading, busy, restack, setParent } = useStacks(open ? rootDir : null, deps)
  const [child, setChild] = useState("")
  const [parent, setParent_] = useState("")

  const local = branches.filter((branch) => !branch.isRemote)

  const record = async () => {
    if (!child || !parent || child === parent) return
    try {
      await setParent(child, parent)
      setChild("")
      setParent_("")
    } catch (err) {
      toast.error(t("error", { message: errorDetail(err) }))
    }
  }

  const runRestack = async (row: StackRow) => {
    try {
      const result = await restack(row.stack)
      if (!result) return
      if (result.status === "upToDate") toast.success(t("result.upToDate"))
      else if (result.status === "restacked")
        toast.success(t("result.restacked", { count: result.updates.length }))
      else if (result.status === "conflict")
        toast.warning(t("result.conflict", { branch: result.branch, worktree: result.worktree }))
      else toast.warning(t("result.refused"))
    } catch (err) {
      toast.error(t("error", { message: errorDetail(err) }))
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>

        <ScrollArea className="h-[calc(100vh-9rem)] px-4 pb-4">
          <div className="space-y-3" data-testid="stack-panel-body">
            {loading ? (
              <div className="flex justify-center py-6">
                <Spinner className="size-4" />
              </div>
            ) : rows.length === 0 ? (
              <div className="space-y-1" data-testid="stack-panel-empty">
                <p className="text-xs text-muted-foreground">{t("empty")}</p>
                <p className="text-[10px] text-muted-foreground">{t("emptyHint")}</p>
              </div>
            ) : (
              rows.map((row) => (
                <StackCard
                  key={row.stack.id}
                  row={row}
                  busy={busy === row.stack.id}
                  onRestack={() => void runRestack(row)}
                  onUnstack={(branch) => void setParent(branch, null)}
                />
              ))
            )}

            <div className={cn("space-y-2 rounded-md border border-dashed p-3")}>
              <p className="text-[11px] font-medium">{t("stackOn")}</p>
              <div className="grid gap-2">
                <div className="space-y-1">
                  <Label className="text-[10px]">{t("branch")}</Label>
                  <Select value={child} onValueChange={setChild}>
                    <SelectTrigger className="h-8 text-xs" aria-label={t("branch")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {local.map((branch) => (
                        <SelectItem key={branch.name} value={branch.name}>
                          {branch.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px]">{t("parent")}</Label>
                  <Select value={parent} onValueChange={setParent_}>
                    <SelectTrigger className="h-8 text-xs" aria-label={t("parent")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {local
                        .filter((branch) => branch.name !== child)
                        .map((branch) => (
                          <SelectItem key={branch.name} value={branch.name}>
                            {branch.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px]"
                  disabled={!child || !parent || child === parent || busy !== null}
                  onClick={() => void record()}
                  data-testid="stack-record-parent"
                >
                  {t("record")}
                </Button>
              </div>
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
