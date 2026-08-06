"use client"

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { CodeBlock } from "@/components/ai-elements/code-block"
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation"
import { DiffPreview } from "@/components/chat/message-parts/mcp-renderers/diff-preview"
import type { ApprovalDecision, PendingApproval } from "@cognia/agent-config-types"
import { ShieldAlertIcon } from "lucide-react"

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

/** Bare tool name with the cognia-tools MCP prefix stripped. */
function bareToolName(toolName: string | undefined): string {
  const name = toolName ?? ""
  const CORE_PREFIX = "mcp__cognia-tools__"
  return name.startsWith(CORE_PREFIX) ? name.slice(CORE_PREFIX.length) : name
}

/**
 * Tool-aware preview of the approval payload: shell commands render as a
 * bash block, edit/write payloads as a diff/content preview. Anything else
 * keeps the generic JSON dump.
 */
function ApprovalInputPreview({ approval }: { approval: PendingApproval }) {
  const name = bareToolName(approval.toolName)
  const input = (approval.input ?? {}) as Record<string, unknown>

  if ((name === "bash" || name === "Bash") && typeof input.command === "string") {
    return (
      <div data-testid="approval-bash-preview">
        <CodeBlock code={input.command} language="bash" />
        {typeof input.description === "string" && input.description && (
          <p className="mt-1 text-xs text-muted-foreground">{input.description}</p>
        )}
      </div>
    )
  }

  if (
    (name === "edit" || name === "Edit") &&
    typeof input.old_string === "string" &&
    typeof input.new_string === "string"
  ) {
    return (
      <div data-testid="approval-edit-preview" className="space-y-1">
        {typeof input.file_path === "string" && (
          <p className="font-mono text-xs text-muted-foreground">{input.file_path}</p>
        )}
        <DiffPreview oldText={input.old_string} newText={input.new_string} />
      </div>
    )
  }

  if ((name === "multi_edit" || name === "MultiEdit") && Array.isArray(input.edits)) {
    return (
      <div data-testid="approval-multi-edit-preview" className="space-y-1">
        {typeof input.file_path === "string" && (
          <p className="font-mono text-xs text-muted-foreground">{input.file_path}</p>
        )}
        {(input.edits as Array<Record<string, unknown>>).map((e, i) => (
          <DiffPreview
            key={i}
            oldText={typeof e.old_string === "string" ? e.old_string : ""}
            newText={typeof e.new_string === "string" ? e.new_string : ""}
          />
        ))}
      </div>
    )
  }

  if ((name === "write" || name === "Write") && typeof input.content === "string") {
    return (
      <div data-testid="approval-write-preview" className="space-y-1">
        {typeof input.file_path === "string" && (
          <p className="font-mono text-xs text-muted-foreground">{input.file_path}</p>
        )}
        <DiffPreview oldText="" newText={input.content.slice(0, 4000)} />
      </div>
    )
  }

  return <CodeBlock code={JSON.stringify(approval.input, null, 2)} language="json" />
}

export function ToolApprovalDialog({ approval, onRespond, onDismiss, onCancelRun }: Props) {
  const t = useTranslations("chat.toolApproval")
  const open = !!approval
  const interrupted = approval?.status === "interrupted"
  const isSubagent = approval?.origin === "subagent"
  return (
    <Dialog open={open}>
      <DialogContent
        // The Claude side blocks until we respond — preventing close avoids
        // an "X" button that would orphan the pending Promise.
        showCloseButton={false}
        className="max-w-xl max-w-[calc(100vw-2rem)] sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlertIcon className="size-4 text-amber-500" />
            {approval?.title ?? t("titleFallback", { tool: approval?.toolName ?? "" })}
          </DialogTitle>
          {isSubagent && approval && (
            <DialogDescription data-testid="approval-subagent-origin">
              {t("askedBySubagent", {
                subagent: approval.subagentId ?? "",
                runId: (approval.subagentRunId ?? "").slice(0, 8),
              })}
            </DialogDescription>
          )}
          {approval?.description && <DialogDescription>{approval.description}</DialogDescription>}
        </DialogHeader>

        {approval && (
          // `min-w-0` lets this grid item shrink below its content's intrinsic
          // width so the code/JSON previews below scroll inside their own
          // `overflow-x-auto` box instead of stretching the dialog past its
          // `max-w-xl`.
          <div className="min-w-0 space-y-3 text-sm">
            <div className="min-w-0">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("toolLabel")}
              </div>
              {/* Namespaced tool names (e.g. mcp__cognia-plugin-tools__…) have
                  no spaces; `break-all` wraps them instead of overflowing. */}
              <div className="break-all font-mono text-sm">
                {approval.displayName ?? approval.toolName}
              </div>
            </div>
            <div className="min-w-0">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("inputLabel")}
              </div>
              <ApprovalInputPreview approval={approval} />
            </div>
            {approval.decisionReason && (
              <p className="text-xs text-muted-foreground">{approval.decisionReason}</p>
            )}
            {interrupted && (
              // Honest terminal: the sidecar waiter died with the turn and the
              // tool was already denied — there is nothing left to answer, so
              // Approve/Deny would be a lie. Dismiss is the only real action.
              <p data-testid="approval-interrupted-notice" className="text-xs text-amber-600">
                {t("interruptedNotice")}
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {interrupted ? (
            <Button variant="secondary" onClick={() => onDismiss?.()}>
              {t("dismiss")}
            </Button>
          ) : (
            approval && (
              <Confirmation
                approval={{ id: approval.id }}
                className="w-full border-0 p-0"
                state="approval-requested"
              >
                <ConfirmationRequest>
                  <ConfirmationTitle className="sr-only">{t("actionsTitle")}</ConfirmationTitle>
                  <ConfirmationActions className="w-full">
                    {isSubagent && approval.subagentRunId && onCancelRun && (
                      <ConfirmationAction
                        variant="ghost"
                        className="mr-auto text-destructive"
                        onClick={() => onCancelRun(approval.subagentRunId!)}
                      >
                        {t("cancelRun")}
                      </ConfirmationAction>
                    )}
                    {/* Deny only this tool call; the subagent run remains alive. */}
                    <ConfirmationAction variant="ghost" onClick={() => void onRespond("deny")}>
                      {t("deny")}
                    </ConfirmationAction>
                    <ConfirmationAction
                      variant="secondary"
                      onClick={() => void onRespond("allow_always")}
                    >
                      {t("allowAlways")}
                    </ConfirmationAction>
                    <ConfirmationAction onClick={() => void onRespond("allow")}>
                      {t("allowOnce")}
                    </ConfirmationAction>
                  </ConfirmationActions>
                </ConfirmationRequest>
              </Confirmation>
            )
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
