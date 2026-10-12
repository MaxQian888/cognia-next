"use client"

/**
 * The live card of a `!` line running as a supervised job.
 *
 * It renders the run's snapshot (`lib/shell-intelligence/shell-job-run.ts`),
 * never message fields: output is streamed into memory, and the transcript
 * only receives the settled result, which replaces this card. While the job
 * runs the card offers "Move to background" (the job carries on in the Job
 * Center and its result is posted later) and "Stop".
 *
 * A card with no run behind it — after a reload, or in a second client
 * viewing the same conversation — re-attaches once. A job this client cannot
 * see is shown as detached; nothing is written for it.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { SquareIcon, SquareTerminalIcon, UnplugIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { shellJobTranscript } from "@/lib/chat/shell-job-transcript"
import {
  getShellJobRun,
  reattachShellJobRun,
  type ShellJobRun,
} from "@/lib/shell-intelligence/shell-job-run"
import type { ShellJobBlock } from "@/lib/slash-commands/system-blocks"
import { loggers } from "@cognia/logging"
import { useShellJobCopy } from "./use-shell-job-copy"

export function ShellJobView({ block }: { block: ShellJobBlock }) {
  const copy = useShellJobCopy()
  // Lazily, and exactly once per card: the run registry makes a second call
  // for the same job return the run already following it, so a re-render, a
  // Strict Mode double mount or a split view cannot start two.
  const [run] = useState<ShellJobRun>(
    () =>
      getShellJobRun(block.jobId) ??
      reattachShellJobRun(block, { transcript: shellJobTranscript, copy })
  )
  return <ShellJobCard run={run} />
}

export function ShellJobCard({ run }: { run: ShellJobRun }) {
  const t = useTranslations("chat.composer.shell.job")
  const snapshot = useSyncExternalStore(run.subscribe, run.getSnapshot, run.getSnapshot)
  const outputRef = useRef<HTMLPreElement>(null)
  const { command, cwd, phase, output, stopping } = snapshot
  const live = phase === "running"

  // Follow the tail the way a terminal does.
  useEffect(() => {
    const el = outputRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [output.text])

  const onStop = async () => {
    try {
      await run.stop()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      loggers.chat.warn("stopping a shell job failed", { jobId: snapshot.jobId, error: detail })
      toast.error(t("stopFailed", { cmd: command, error: detail }))
    }
  }

  return (
    <div
      data-testid="shell-job-card"
      data-phase={phase}
      className="my-1 space-y-2 rounded-md border bg-muted/20 p-3 text-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 font-mono font-medium">
          <SquareTerminalIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate" title={command}>
            $ {command}
          </span>
        </span>
        {live && (
          <Badge variant="outline" className="shrink-0 gap-1 text-[10px]">
            <Spinner className="size-3" />
            {stopping ? t("stopping") : t("running")}
          </Badge>
        )}
      </div>
      <p className="truncate font-mono text-[10px] text-muted-foreground" title={cwd}>
        {cwd}
      </p>

      {phase === "detached" ? (
        <p
          className="flex items-center gap-1.5 text-muted-foreground"
          data-testid="shell-job-detached"
        >
          <UnplugIcon className="size-3 shrink-0" aria-hidden />
          {t("detached")}
        </p>
      ) : (
        <>
          {output.truncated && (
            <p className="text-[10px] text-muted-foreground">{t("liveTruncated")}</p>
          )}
          <pre
            ref={outputRef}
            role="log"
            aria-live="polite"
            aria-label={t("outputLabel", { cmd: command })}
            className="max-h-64 overflow-auto rounded bg-background/60 p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap break-words"
          >
            {output.text || <span className="text-muted-foreground">{t("waiting")}</span>}
          </pre>
        </>
      )}

      {live && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => void run.moveToBackground()}
          >
            {t("moveToBackground")}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={stopping}
            onClick={() => void onStop()}
          >
            <SquareIcon className="size-3" aria-hidden />
            {t("stop")}
          </Button>
        </div>
      )}
    </div>
  )
}
