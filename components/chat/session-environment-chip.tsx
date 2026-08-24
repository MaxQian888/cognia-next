"use client"

import { AlertTriangleIcon, GitBranchIcon, LaptopIcon, Settings2Icon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { cn } from "@/lib/utils"
import type { SessionExecutionContext, SessionWorkspaceBaseSpec } from "@/types/execution-context"
import { resolveSessionWorkspaceRoot } from "@/lib/task-workspace/session-execution-context"

interface SessionEnvironmentChipProps {
  executionContext?: SessionExecutionContext
  onManage: () => void
}

function leafName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "")
  return normalized.split(/[\\/]/).at(-1) || path
}

function baseLabel(
  t: ReturnType<typeof useTranslations>,
  base: SessionWorkspaceBaseSpec | undefined
): string {
  if (!base || base.kind === "workingState") return t("bases.workingState")
  if (base.kind === "localHead") return t("bases.localHead")
  if (base.kind === "remoteDefault") return t("bases.remoteDefault")
  if (base.kind === "gitRef") return t("bases.gitRef", { ref: base.gitRef })
  return t("bases.pullRequest", { provider: base.provider, number: base.number })
}

/** Persistent, session-scoped summary of the physical execution environment. */
export function SessionEnvironmentChip({
  executionContext,
  onManage,
}: SessionEnvironmentChipProps) {
  const t = useTranslations("chat.header.environment")
  const execution = executionContext?.execution
  const mode =
    execution?.mode ?? (executionContext?.location === "managedWorktree" ? "managed" : "local")
  // One resolver for the displayed root, so the chip cannot name a directory
  // the send would not use. A managed workspace that is not materialized on
  // this device resolves to nothing rather than to a source root it does not
  // have.
  const path = executionContext ? (resolveSessionWorkspaceRoot(executionContext) ?? "") : ""
  const branch = executionContext?.branch
  const state = executionContext?.lifecycle?.state
  const conflict = state === "conflict"
  const modeLabel = t(`modes.${mode}`)

  return (
    <HoverCard openDelay={0} closeDelay={100}>
      <HoverCardTrigger asChild>
        <div
          tabIndex={0}
          className={cn(
            "inline-flex h-7 max-w-48 items-center gap-1.5 rounded-md border px-2 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
            conflict && "border-destructive/50 text-destructive"
          )}
          aria-label={t("aria", { mode: modeLabel })}
        >
          {conflict ? (
            <AlertTriangleIcon className="size-3.5 shrink-0" aria-hidden />
          ) : mode === "local" ? (
            <LaptopIcon className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <GitBranchIcon className="size-3.5 shrink-0" aria-hidden />
          )}
          <span className="truncate">{path ? `${modeLabel} · ${leafName(path)}` : modeLabel}</span>
        </div>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80 space-y-3">
        <div>
          <p className="text-sm font-medium">{modeLabel}</p>
          {path ? <p className="mt-1 break-all text-xs text-muted-foreground">{path}</p> : null}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">{t("base")}</dt>
          <dd>{baseLabel(t, execution?.base)}</dd>
          {branch ? (
            <>
              <dt className="text-muted-foreground">{t("branch")}</dt>
              <dd className="truncate">{branch}</dd>
            </>
          ) : null}
          {state ? (
            <>
              <dt className="text-muted-foreground">{t("state")}</dt>
              <dd className={cn(conflict && "font-medium text-destructive")}>{state}</dd>
            </>
          ) : null}
        </dl>
        <Button type="button" variant="outline" size="sm" className="w-full" onClick={onManage}>
          <Settings2Icon className="size-3.5" aria-hidden />
          {t("manage")}
        </Button>
      </HoverCardContent>
    </HoverCard>
  )
}
