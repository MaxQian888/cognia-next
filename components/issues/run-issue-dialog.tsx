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
import { cn } from "@/lib/utils"
import {
  DEFAULT_GITHUB_LOOP_BASE,
  GITHUB_LOOP_BASE_OPTION,
  GITHUB_LOOP_RUN_ADAPTER_ID,
} from "@/lib/issues/run/github-loop-adapter"
import {
  IssueRunRefusedError,
  listIssueRunOptions,
  startIssueRun,
  type IssueRunOption,
} from "@/lib/issues/run/registry"
import type { IssueRun } from "@/types/issues"

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
          ? { options: { [GITHUB_LOOP_BASE_OPTION]: base } }
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
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="run-issue-base">{t("run.baseBranch")}</Label>
              <Input
                id="run-issue-base"
                value={base}
                onChange={(event) => setBase(event.target.value)}
                className="font-mono"
                data-testid="run-issue-base"
              />
              <p className="text-xs text-muted-foreground">{t("run.baseBranchHint")}</p>
            </div>
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
