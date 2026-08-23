"use client"

/**
 * Desktop modal wrapper around the shared decision surface.
 *
 * Everything readable and every action now lives in
 * `components/chat/decisions/pending-decision-surface.tsx`; what is left here is
 * the modal itself — the part that is genuinely desktop-specific, because the
 * Claude side blocks until we respond and the dialog must not offer a close
 * button that would orphan the pending promise.
 */

import { useTranslations } from "next-intl"
import { ShieldAlertIcon } from "lucide-react"

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { PendingDecisionSurface } from "@/components/chat/decisions/pending-decision-surface"
import type { ApprovalDecision, PendingApproval } from "@cognia/agent-config-types"

interface Props {
  approval: PendingApproval | null
  onRespond: (decision: ApprovalDecision) => void | Promise<void>
  /** Dismiss an `interrupted` approval (the waiter is gone — there is nothing
   * to answer). Required to clear the honest-notice card. */
  onDismiss?: () => void
  /** Cancel the whole subagent run behind a subagent-origin approval (deny-one
   * denies a single tool call; this aborts the run). Optional. */
  onCancelRun?: (runId: string) => void
}

export function ToolApprovalDialog({ approval, onRespond, onDismiss, onCancelRun }: Props) {
  const t = useTranslations("chat.toolApproval")
  return (
    <Dialog open={!!approval}>
      <DialogContent
        // The Claude side blocks until we respond — preventing close avoids
        // an "X" button that would orphan the pending Promise.
        showCloseButton={false}
        // One `max-w` per breakpoint: two base-width utilities on the same
        // element only look like a base plus a clamp — tailwind-merge keeps the
        // last and drops the other.
        className="max-w-[calc(100vw-2rem)] sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlertIcon className="size-4 text-amber-500" />
            {approval?.title ?? t("titleFallback", { tool: approval?.toolName ?? "" })}
          </DialogTitle>
        </DialogHeader>

        {approval && (
          <PendingDecisionSurface
            decision={{ kind: "tool-approval", approval }}
            status={approval.status === "interrupted" ? "interrupted" : "pending"}
            onApprovalRespond={onRespond}
            onDismiss={onDismiss}
            onCancelRun={onCancelRun}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
