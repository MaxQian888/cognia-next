"use client"

/**
 * The body of a tool-permission decision, without any container.
 *
 * Extracted from `chat/tool-approval-dialog.tsx` because three surfaces need
 * exactly this and only one of them is a modal: the desktop dialog, the
 * external-agent dialog, and the remote session queue (where several decisions
 * can be open at once inside a Drawer). The remote surface had grown its own
 * version — a `<pre>{JSON.stringify(input)}</pre>` — which is how a phone ended
 * up showing the raw arguments of a tool the desktop rendered as a diff, with
 * no truncation and no subagent attribution.
 *
 * Deliberately renders no chrome and owns no state: the caller supplies the
 * card, the dialog, or the drawer row, and the actions. What lives here is the
 * part that must not drift between them — how a tool call is *shown*.
 */

import { useTranslations } from "next-intl"

import { CodeBlock } from "@/components/ai-elements/code-block"
import { DiffPreview } from "@/components/chat/message-parts/mcp-renderers/diff-preview"
import { cn } from "@/lib/utils"
import type { PendingApproval } from "@cognia/agent-config-types"

/** How much of a `write` payload is worth previewing before it is just noise. */
const WRITE_PREVIEW_LIMIT = 4000

/**
 * Cap on the generic JSON dump.
 *
 * The tool-aware branches below all bound what they show; the fallback did not,
 * so an approval carrying a large payload rendered the whole thing. On a phone
 * that is a scroll trap in front of a decision the run is blocked on.
 */
const JSON_PREVIEW_LIMIT = 8000

/** Bare tool name with the cognia-tools MCP prefix stripped. */
export function bareToolName(toolName: string | undefined): string {
  const name = toolName ?? ""
  const CORE_PREFIX = "mcp__cognia-tools__"
  return name.startsWith(CORE_PREFIX) ? name.slice(CORE_PREFIX.length) : name
}

/**
 * Tool-aware preview of the approval payload: shell commands render as a
 * bash block, edit/write payloads as a diff/content preview. Anything else
 * keeps the generic JSON dump.
 */
export function ToolInputPreview({ approval }: { approval: PendingApproval }) {
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
        <DiffPreview oldText="" newText={input.content.slice(0, WRITE_PREVIEW_LIMIT)} />
      </div>
    )
  }

  const json = JSON.stringify(approval.input, null, 2) ?? ""
  return (
    <CodeBlock
      code={json.length > JSON_PREVIEW_LIMIT ? `${json.slice(0, JSON_PREVIEW_LIMIT)}\n…` : json}
      language="json"
    />
  )
}

export interface ToolDecisionContentProps {
  approval: PendingApproval
  /**
   * `observe` shows that a decision exists and what tool it names, but not the
   * arguments. A watcher without control cannot answer it, and the arguments
   * are the part that carries file contents, commands and credentials.
   */
  mode?: "control" | "observe"
  className?: string
}

/**
 * Tool name, arguments, origin, and any terminal notice — the whole readable
 * part of a permission decision.
 */
export function ToolDecisionContent({
  approval,
  mode = "control",
  className,
}: ToolDecisionContentProps) {
  const t = useTranslations("chat.toolApproval")
  const isSubagent = approval.origin === "subagent"
  const interrupted = approval.status === "interrupted"

  return (
    // `min-w-0` lets this shrink below its content's intrinsic width so the
    // code/JSON previews scroll inside their own `overflow-x-auto` box instead
    // of stretching the container past its max width.
    <div className={cn("min-w-0 space-y-3 text-sm", className)} data-testid="tool-decision-content">
      {isSubagent && (
        <p className="text-xs text-muted-foreground" data-testid="approval-subagent-origin">
          {t("askedBySubagent", {
            subagent: approval.subagentId ?? "",
            runId: (approval.subagentRunId ?? "").slice(0, 8),
          })}
        </p>
      )}
      {approval.description && <p className="text-muted-foreground">{approval.description}</p>}
      <div className="min-w-0">
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("toolLabel")}
        </div>
        {/* Namespaced tool names (e.g. mcp__cognia-plugin-tools__…) have no
            spaces; `break-all` wraps them instead of overflowing. */}
        <div className="break-all font-mono text-sm">
          {approval.displayName ?? approval.toolName}
        </div>
      </div>
      {mode === "control" ? (
        <div className="min-w-0">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("inputLabel")}
          </div>
          <ToolInputPreview approval={approval} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="approval-observe-redacted">
          {t("observeRedacted")}
        </p>
      )}
      {approval.decisionReason && (
        <p className="text-xs text-muted-foreground">{approval.decisionReason}</p>
      )}
      {interrupted && (
        // Honest terminal: the sidecar waiter died with the turn and the tool
        // was already denied — there is nothing left to answer, so Approve/Deny
        // would be a lie.
        <p data-testid="approval-interrupted-notice" className="text-xs text-amber-600">
          {t("interruptedNotice")}
        </p>
      )}
    </div>
  )
}
