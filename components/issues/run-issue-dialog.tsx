"use client"

/**
 * Run an issue — pick the execution engine, confirm, dispatch.
 *
 * The dialog IS the confirmation step for every adapter (the GitHub loop's
 * write-tier integration job is released on this click), so it always shows
 * exactly what will happen: which engine, for which assignee, and any refusal
 * reason for the engines that cannot run this issue right now. Refusals are
 * rendered greyed-out WITH their reason rather than hidden — the honesty rule
 * from `types/issues/unified.ts` applies to the run affordance too.
 *
 * All the policy lives in `lib/issues/run/registry.ts`; this component only
 * localizes verdicts and collects the per-adapter options.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { PlayIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  DEFAULT_GITHUB_LOOP_BASE,
  GITHUB_LOOP_BASE_OPTION,
  GITHUB_LOOP_RUN_ADAPTER_ID,
  GITHUB_LOOP_STACK_ON_OPTION,
  boundRepoFor,
  stackCandidatesFrom,
  type GithubLoopStackCandidate,
} from "@/lib/issues/run/github-loop-adapter"
import {
  IssueRunRefusedError,
  listIssueRunOptions,
  startIssueRun,
  type IssueRunOption,
} from "@/lib/issues/run/registry"
import type { IssueRun } from "@/types/issues"

/**
 * Sentinel for "not stacked".
 *
 * Radix `SelectItem` refuses an empty value (it uses "" for the cleared state),
 * so the no-stack choice needs a value of its own rather than "".
 */
const NOT_STACKED = "__none__"

/**
 * Branches this issue could stack on: what other issues in the same delivery
 * container have already pushed to the same repository.
 *
 * Returns nothing rather than throwing — an issue with no GitHub link, no
 * container, or no sibling runs simply has no stack to join, and the picker
 * is then not rendered at all.
 */
async function loadStackCandidates(issueId: string): Promise<GithubLoopStackCandidate[]> {
  try {
    const [{ getIssue }, { getIssueProject }, { listIssueRuns }] = await Promise.all([
      import("@/lib/db/issues"),
      import("@/lib/db/issue-projects"),
      import("@/lib/db/issue-runs"),
    ])
    const issue = await getIssue(issueId)
    if (!issue?.issueProjectId) return []
    const project = await getIssueProject(issue.issueProjectId)
    const repoFullName = boundRepoFor({ issue, project })
    if (!repoFullName) return []
    const runs = await listIssueRuns({ projectId: issue.projectId })
    return stackCandidatesFrom(runs, { issueId, repoFullName })
  } catch {
    return []
  }
}

export interface RunIssueDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Local issue id (never a federated row). */
  issueId: string
  identifier: string
  onStarted?: (run: IssueRun) => void
}

export function RunIssueDialog({
  open,
  onOpenChange,
  issueId,
  identifier,
  onStarted,
}: RunIssueDialogProps) {
  const t = useTranslations("issues")
  const [options, setOptions] = useState<IssueRunOption[] | null>(null)
  const [adapterId, setAdapterId] = useState<string | null>(null)
  const [base, setBase] = useState(DEFAULT_GITHUB_LOOP_BASE)
  const [stackOn, setStackOn] = useState(NOT_STACKED)
  const [stackCandidates, setStackCandidates] = useState<GithubLoopStackCandidate[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void listIssueRunOptions(issueId).then((loaded) => {
      if (cancelled) return
      setOptions(loaded)
      // Default to the first engine that can actually run it.
      const first = loaded.find((option) => option.verdict.ok)
      setAdapterId(first ? first.adapter.id : null)
    })
    return () => {
      cancelled = true
    }
  }, [open, issueId])

  // Branches an earlier issue in this repository already pushed. Loaded when
  // the dialog opens rather than on selecting the engine, so the option is
  // there the moment the engine is — a picker that appears a beat later reads
  // as the dialog changing its mind.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void loadStackCandidates(issueId).then((loaded) => {
      if (cancelled) return
      setStackCandidates(loaded)
      setStackOn(NOT_STACKED)
    })
    return () => {
      cancelled = true
    }
  }, [open, issueId])

  const selected = options?.find((option) => option.adapter.id === adapterId)
  const canSubmit = Boolean(selected?.verdict.ok) && !busy

  async function submit() {
    if (!selected) return
    setBusy(true)
    setError(null)
    try {
      const run = await startIssueRun({
        issueId,
        adapterId: selected.adapter.id,
        by: { kind: "human" },
        origin: "interactive",
        ...(selected.adapter.id === GITHUB_LOOP_RUN_ADAPTER_ID
          ? {
              options: {
                [GITHUB_LOOP_BASE_OPTION]: base,
                ...(stackOn === NOT_STACKED ? {} : { [GITHUB_LOOP_STACK_ON_OPTION]: stackOn }),
              },
            }
          : {}),
      })
      toast.success(
        t("run.started", { identifier, adapter: t(`run.adapter.${run.adapterId}.name`) })
      )
      onStarted?.(run)
      onOpenChange(false)
    } catch (cause) {
      if (cause instanceof IssueRunRefusedError) {
        setError(t(`run.refusal.${cause.reason}`))
      } else {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="run-issue-dialog">
        <DialogHeader>
          <DialogTitle>{t("run.title", { identifier })}</DialogTitle>
          <DialogDescription>{t("run.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {options === null ? (
            <p className="text-sm text-muted-foreground" data-testid="run-issue-loading">
              {t("run.loading")}
            </p>
          ) : options.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="run-issue-empty">
              {t("run.noAdapters")}
            </p>
          ) : (
            <div
              role="radiogroup"
              aria-label={t("run.engineLabel")}
              className="flex flex-col gap-2"
            >
              {options.map(({ adapter, verdict }) => {
                const active = adapter.id === adapterId
                return (
                  <button
                    key={adapter.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={!verdict.ok}
                    onClick={() => setAdapterId(adapter.id)}
                    data-testid={`run-issue-adapter-${adapter.id}`}
                    className={cn(
                      "flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                      active ? "border-primary bg-primary/5" : "hover:bg-muted/50",
                      !verdict.ok && "cursor-not-allowed opacity-60"
                    )}
                  >
                    <span className="font-medium">{t(`run.adapter.${adapter.id}.name`)}</span>
                    <span className="text-xs text-muted-foreground">
                      {verdict.ok
                        ? t(`run.adapter.${adapter.id}.description`)
                        : t(`run.refusal.${verdict.reason}`)}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {adapterId === GITHUB_LOOP_RUN_ADAPTER_ID && selected?.verdict.ok ? (
            <>
              {stackCandidates.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="run-issue-stack">{t("run.stackOn")}</Label>
                  <Select value={stackOn} onValueChange={setStackOn}>
                    <SelectTrigger
                      id="run-issue-stack"
                      className="font-mono"
                      data-testid="run-issue-stack"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NOT_STACKED}>{t("run.stackOnNone")}</SelectItem>
                      {stackCandidates.map((candidate) => (
                        <SelectItem key={candidate.branch} value={candidate.branch}>
                          {candidate.branch}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{t("run.stackOnHint")}</p>
                </div>
              ) : null}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="run-issue-base">{t("run.baseBranch")}</Label>
                <Input
                  id="run-issue-base"
                  value={stackOn === NOT_STACKED ? base : stackOn}
                  onChange={(event) => setBase(event.target.value)}
                  className="font-mono"
                  disabled={stackOn !== NOT_STACKED}
                  data-testid="run-issue-base"
                />
                {/*
                  A pull request has one base, and stacking IS that base. The
                  field shows the stack branch and locks rather than sitting
                  there editable and ignored.
                */}
                <p className="text-xs text-muted-foreground">
                  {stackOn === NOT_STACKED ? t("run.baseBranchHint") : t("run.baseBranchStacked")}
                </p>
              </div>
            </>
          ) : null}

          <p className="text-xs text-muted-foreground">{t("run.reviewRule")}</p>

          {error ? (
            <p className="text-sm text-destructive" data-testid="run-issue-error">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("create.cancel")}
          </Button>
          <Button onClick={submit} disabled={!canSubmit} data-testid="run-issue-submit">
            <PlayIcon className="size-4" />
            {t("run.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
