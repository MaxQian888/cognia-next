"use client"

/**
 * WorkflowProposalCard — structured renderer for the `wf_propose_batch`
 * and `wf_apply_template` MCP tool results. Wired into the host
 * MCPToolCard registry so the proposal lands inline inside the chat
 * stream, right under the agent's prose summary.
 *
 * Lifecycle:
 *   • The tool result carries `{ proposalId, workflowId, summary, opCount }`
 *     (with `messageParts` echoed for future tooling — not consumed
 *     directly here).
 *   • The card subscribes to `useProposalStore` keyed by `proposalId` and
 *     re-renders as the status changes (open → applied | discarded).
 *   • Apply: load the proposal payload from the store, call the editor's
 *     `applyProposalOps`, then `markApplied`. Surface any apply error
 *     (e.g. a dangling reference the user introduced manually between
 *     propose and apply).
 *   • Discard: call `discardProposal` and let the status transition to
 *     "discarded" so the card shows a strikethrough state.
 *
 * The component is intentionally pure of i18n strings — labels come from
 * the `workflowEditor.chat.proposal.*` namespace via `useTranslations`.
 * Tests assert on `data-testid` selectors.
 */

import { useTranslations } from "next-intl"
import { useOptimistic, useState, useTransition } from "react"
import type { ToolUIPart } from "ai"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  XCircleIcon,
  ZapIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useProposalStore, type ProposalStatus } from "@/lib/workflow/editor/proposal-store"
import { getEditorStore } from "@/lib/workflow/editor/store-registry"
import { parseOutputJson } from "@/components/chat/message-parts/mcp-renderers/common"
import type { ProposalOp, ProposalOpCount } from "@/lib/workflow/editor/proposal-types"
import { PerfBoundary } from "@/lib/perf"

interface ProposeBatchOutput {
  ok?: boolean
  proposalId?: string
  workflowId?: string
  summary?: string
  opCount?: ProposalOpCount
  error?: { code?: string; message?: string }
  /**
   * Echo of the full proposal (including `ops`) emitted by the tool. On the
   * renderer that executed `wf_propose_batch` the proposal already sits in
   * `useProposalStore`; on a DIFFERENT renderer of the same session (the
   * mobile copilot pairs with a desktop that ran the tool, and vice versa)
   * the store is empty — the card seeds it from this echo so Apply works
   * against the local editor store.
   */
  messageParts?: Array<{
    type?: string
    proposalId?: string
    workflowId?: string
    summary?: string
    ops?: ProposalOp[]
  }>
}

export function WorkflowProposalCard({ part }: { part: ToolUIPart }) {
  const t = useTranslations("workflowEditor.chat.proposal")
  const parsed = parseOutputJson(part.output) as ProposeBatchOutput | null

  // Hook calls run unconditionally (rules of hooks) — the early returns
  // below skip render once we know there's no proposal to display.
  const realStatus = useProposalStore((s) =>
    parsed?.proposalId ? s.statusOf(parsed.proposalId) : undefined
  )
  const [optimisticStatus, addOptimisticStatus] = useOptimistic<
    ProposalStatus | undefined,
    ProposalStatus
  >(realStatus, (_, next) => next)
  const [, startApplyTransition] = useTransition()
  const [expanded, setExpanded] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)

  if (!parsed) return null
  // Tool errored OR tool returned ok:false — show a compact error pill
  // and let the generic ToolBody render via fallback (return null).
  if (parsed.ok === false || parsed.error) {
    return null
  }
  const { proposalId, workflowId, summary, opCount } = parsed
  if (!proposalId || !workflowId || !summary || !opCount) return null

  const effectiveStatus = optimisticStatus ?? realStatus ?? "open"

  // Full ops echoed in the tool result — the seed source when THIS renderer
  // never ran the tool (cross-device copilot session).
  const echoedOps = parsed.messageParts?.find(
    (p) => p?.type === "workflow-proposal" && p.proposalId === proposalId
  )?.ops

  const handleApply = () => {
    setApplyError(null)
    let proposal = useProposalStore.getState().getProposal(proposalId)
    if (!proposal && echoedOps && echoedOps.length > 0) {
      // Seed the local proposal store from the tool-result echo so Apply /
      // Discard / changelog behave exactly as if the tool ran here.
      proposal = useProposalStore.getState().openProposal(workflowId, {
        proposalId,
        workflowId,
        summary,
        ops: echoedOps,
      })
    }
    if (!proposal) {
      setApplyError(t("errorNotFound"))
      return
    }
    // Capture the editor-store handle OUTSIDE the transition closure so a
    // mid-transition editor unmount can't leave a stale reference inside
    // the deferred work.
    const store = getEditorStore(workflowId)
    if (!store) {
      setApplyError(t("errorEditorNotOpen"))
      return
    }
    let firstError: string | undefined
    startApplyTransition(() => {
      // Optimistic flip — the badge / button instantly switches to
      // "applied" while the canvas re-render runs at transition priority.
      // If `applyProposalOps` errors below, we skip `markApplied`; the
      // optimistic value auto-reverts to the real status (still "open")
      // once the transition settles.
      addOptimisticStatus("applied")
      const result = store.getState().applyProposalOps(proposal.ops)
      if (result.firstError) {
        firstError = result.firstError
        return
      }
      useProposalStore.getState().markApplied(workflowId)
    })
    if (firstError) {
      // Surface the error outside the transition so the message is
      // visible immediately; the optimistic state has already reverted.
      setApplyError(firstError)
    }
  }

  const handleDiscard = () => {
    setApplyError(null)
    // Cross-device seed (see handleApply) — `discardProposal` no-ops when the
    // store has no open proposal, which would leave the badge stuck on "open".
    if (!useProposalStore.getState().getProposal(proposalId) && echoedOps && echoedOps.length > 0) {
      useProposalStore.getState().openProposal(workflowId, {
        proposalId,
        workflowId,
        summary,
        ops: echoedOps,
      })
    }
    startApplyTransition(() => {
      addOptimisticStatus("discarded")
      useProposalStore.getState().discardProposal(workflowId)
    })
  }

  const proposal = useProposalStore.getState().getProposal(proposalId)
  const opsForDisplay = proposal?.ops ?? echoedOps ?? []

  const aggregate = formatAggregate(opCount)

  return (
    <PerfBoundary id="workflow:proposal-card">
      <div
        data-testid="workflow-proposal-card"
        data-proposal-id={proposalId}
        data-status={effectiveStatus}
        className={cn(
          "my-2 rounded-md border bg-card text-card-foreground transition-opacity",
          effectiveStatus === "discarded" && "opacity-60"
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <ZapIcon className="size-3.5 shrink-0 text-violet-500" aria-hidden="true" />
            <span className="truncate text-xs font-medium" data-testid="workflow-proposal-summary">
              {summary}
            </span>
          </div>
          <Badge
            variant="outline"
            className="shrink-0 text-[10px]"
            data-testid="workflow-proposal-status"
          >
            {t(`status.${effectiveStatus}`)}
          </Badge>
        </div>

        <div className="space-y-2 px-3 py-2 text-xs">
          <div className="flex items-center gap-2 text-muted-foreground">
            <span data-testid="workflow-proposal-aggregate">{aggregate}</span>
          </div>

          {opsForDisplay.length > 0 && (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              data-testid="workflow-proposal-toggle"
            >
              {expanded ? (
                <ChevronDownIcon className="size-3" aria-hidden="true" />
              ) : (
                <ChevronRightIcon className="size-3" aria-hidden="true" />
              )}
              <span>{expanded ? t("hideOps") : t("showOps", { count: opsForDisplay.length })}</span>
            </button>
          )}

          {expanded && opsForDisplay.length > 0 && (
            <ul
              className="list-none space-y-0.5 rounded-sm bg-muted/40 px-2 py-1.5 font-mono text-[10px]"
              data-testid="workflow-proposal-op-list"
            >
              {opsForDisplay.map((op, i) => (
                <li key={i} className="truncate">
                  {formatOp(op)}
                </li>
              ))}
            </ul>
          )}

          {applyError && (
            <div
              className="rounded-sm border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive"
              data-testid="workflow-proposal-error"
              role="alert"
            >
              {applyError}
            </div>
          )}

          {effectiveStatus === "open" && (
            <div className="flex items-center gap-1.5 pt-1">
              <Button
                type="button"
                size="sm"
                className="h-7 gap-1 px-2 text-[11px]"
                onClick={() => void handleApply()}
                data-testid="workflow-proposal-apply"
              >
                <CheckCircle2Icon className="size-3.5" aria-hidden="true" />
                {t("apply")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={handleDiscard}
                data-testid="workflow-proposal-discard"
              >
                <XCircleIcon className="size-3.5" aria-hidden="true" />
                {t("discard")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </PerfBoundary>
  )
}

function formatAggregate(count: ProposalOpCount): string {
  const parts: string[] = []
  if (count.add > 0) parts.push(`+${count.add} nodes`)
  if (count.remove > 0) parts.push(`-${count.remove} nodes`)
  if (count.configure > 0) parts.push(`~${count.configure} configured`)
  if (count.connect > 0) parts.push(`+${count.connect} edges`)
  if (count.disconnect > 0) parts.push(`-${count.disconnect} edges`)
  return parts.length > 0 ? parts.join(" · ") : "no-op"
}

function formatOp(op: {
  type: string
  nodeId?: string
  edgeId?: string
  kind?: string
  source?: string
  target?: string
}): string {
  switch (op.type) {
    case "add_node":
      return `+ node ${op.nodeId} (${op.kind})`
    case "remove_node":
      return `- node ${op.nodeId}`
    case "connect_edge":
      return `+ edge ${op.edgeId} ${op.source}→${op.target}`
    case "disconnect_edge":
      return `- edge ${op.edgeId}`
    case "configure_node":
      return `~ node ${op.nodeId}`
    default:
      return op.type
  }
}

export default WorkflowProposalCard
