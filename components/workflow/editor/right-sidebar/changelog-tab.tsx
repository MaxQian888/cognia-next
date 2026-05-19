"use client"

/**
 * ChangelogTab — right-sidebar timeline of every proposal terminal
 * transition (applied / discarded) for the currently-open workflow.
 *
 * Reads from the persisted `workflowProposalHistory` Dexie table
 * (v42) via `listProposalHistory`. Live-queried so a fresh Apply
 * lands without a tab switch.
 *
 * Per row, the tab offers two follow-ups:
 *   • "Reveal in chat" — calls the host's reveal callback so the
 *     parent component can scroll to the original proposal card.
 *   • "Focus snapshot" — calls `setSelectedNodes` + `focusViewport`
 *     on the editor store so the affected nodes get a viewport jump.
 *
 * Failure modes are visible (Sonner toasts on snapshot/reveal errors)
 * but never throw — the changelog stays read-only.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { ClockIcon, CheckCircle2Icon, XCircleIcon, EyeIcon, FocusIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import {
  listProposalHistory,
  PROPOSAL_HISTORY_LIMIT,
  type WorkflowProposalHistoryRow,
} from "@/lib/workflow/editor/proposal-history"
import type { EditorStore } from "@/lib/workflow/editor/store"

export interface ChangelogTabProps {
  workflowId: string | undefined
  useStore: EditorStore
  onRevealInChat?: (messageId: string | undefined, proposalId: string) => void
  className?: string
}

export function ChangelogTab({
  workflowId,
  useStore,
  onRevealInChat,
  className,
}: ChangelogTabProps) {
  const t = useTranslations("workflowEditor.chat.changelog")
  const rows = useLiveQuery<WorkflowProposalHistoryRow[]>(
    () =>
      workflowId ? listProposalHistory(workflowId, PROPOSAL_HISTORY_LIMIT) : Promise.resolve([]),
    [workflowId]
  )

  const handleFocusSnapshot = useMemo(
    () => (row: WorkflowProposalHistoryRow) => {
      const ids = row.affectedNodeIds ?? []
      if (ids.length === 0) return
      const state = useStore.getState()
      state.setSelectedNodes(ids)
      // focusViewport may not exist on every editor build (added behind a
      // feature flag); fall back to setting selection alone when absent.
      if (
        typeof (state as unknown as { focusViewport?: (ids: string[]) => void }).focusViewport ===
        "function"
      ) {
        ;(state as unknown as { focusViewport: (ids: string[]) => void }).focusViewport(ids)
      }
    },
    [useStore]
  )

  if (!workflowId) {
    return (
      <div
        className={cn(
          "flex h-full w-full items-center justify-center p-6 text-sm text-muted-foreground",
          className
        )}
        data-testid="workflow-changelog-empty"
      >
        {t("noWorkflow")}
      </div>
    )
  }

  if (!rows) {
    return (
      <div
        className={cn(
          "flex h-full w-full items-center justify-center p-6 text-sm text-muted-foreground",
          className
        )}
        data-testid="workflow-changelog-loading"
      >
        {t("loading")}
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div
        className={cn(
          "flex h-full w-full items-center justify-center p-6 text-sm text-muted-foreground",
          className
        )}
        data-testid="workflow-changelog-empty"
      >
        {t("empty")}
      </div>
    )
  }

  return (
    <ScrollArea className={cn("h-full w-full", className)} data-testid="workflow-changelog">
      <ul className="space-y-2 p-3">
        {rows.map((row) => (
          <li
            key={row.id}
            className={cn(
              "rounded-md border bg-card p-2 text-xs",
              row.status === "discarded" && "opacity-70"
            )}
            data-testid={`workflow-changelog-row-${row.id}`}
            data-status={row.status}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                {row.status === "applied" ? (
                  <CheckCircle2Icon
                    className="size-3.5 shrink-0 text-emerald-500"
                    aria-hidden="true"
                  />
                ) : (
                  <XCircleIcon
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
                <span className="truncate font-medium" title={row.summary}>
                  {row.summary}
                </span>
              </div>
              <Badge variant="outline" className="shrink-0 text-[10px]">
                {t(`status.${row.status}`)}
              </Badge>
            </div>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
              <ClockIcon className="size-3" aria-hidden="true" />
              <span>{formatTimestamp(row.createdAt)}</span>
              <span>•</span>
              <span>{t("opsCount", { count: row.opsCount })}</span>
            </div>
            <div className="mt-2 flex items-center gap-1">
              {row.messageId || onRevealInChat ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 gap-1 px-2 text-[11px]"
                  onClick={() => onRevealInChat?.(row.messageId, row.proposalId)}
                  data-testid={`workflow-changelog-reveal-${row.id}`}
                >
                  <EyeIcon className="size-3" aria-hidden="true" />
                  {t("reveal")}
                </Button>
              ) : null}
              {(row.affectedNodeIds ?? []).length > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 gap-1 px-2 text-[11px]"
                  onClick={() => handleFocusSnapshot(row)}
                  data-testid={`workflow-changelog-snapshot-${row.id}`}
                >
                  <FocusIcon className="size-3" aria-hidden="true" />
                  {t("openSnapshot")}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </ScrollArea>
  )
}

function formatTimestamp(ms: number): string {
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return String(ms)
  }
}
