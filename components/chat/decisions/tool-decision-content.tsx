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
import {
  PatchFilesPreview,
  applyPatchFiles,
} from "@/components/chat/message-parts/mcp-renderers/apply-patch-card"
import {
  isScheduleApprovalTool,
  ScheduledTaskApprovalPreview,
} from "@/components/chat/decisions/scheduled-task-approval-preview"
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
 * Tool names that run a shell command, across the runtimes that reach this
 * surface (Claude `Bash`, Kimi Code `Bash`, Gemini `run_shell_command`, Codex
 * `exec_command`/`shell`, Cursor `run_terminal_cmd`, …). Lower-cased.
 */
const SHELL_TOOL_NAMES = new Set([
  "bash",
  "shell",
  "local_shell",
  "run_shell_command",
  "exec_command",
  "execute",
  "terminal",
  "run_command",
  "run_terminal_cmd",
])

/**
 * Argument keys a shell call carries besides the command. A tool whose name
 * is not recognised still renders as a command when its arguments are only
 * these — an ACP agent titles the call however it likes ("Running: echo hi").
 */
const SHELL_ARG_KEYS = new Set([
  "command",
  "cmd",
  "description",
  "cwd",
  "workdir",
  "timeout",
  "timeout_ms",
  "run_in_background",
  "is_background",
])

/** Keys the shell block itself shows; anything else is listed beneath it. */
const SHELL_SHOWN_KEYS = new Set(["command", "cmd", "description"])

/** Keys an edit carries in the Edit/MultiEdit shape (and ACP diffs mapped to it). */
const EDIT_ARG_KEYS = new Set(["file_path", "path", "old_string", "new_string", "replace_all"])

/** POSIX-quote one argv element only when it needs it, so `echo hi` stays readable. */
function quoteArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

/**
 * The command a shell-like call runs, or `undefined` when this is not one.
 * Accepts a string (`command`/`cmd`) or an argv array (Codex `["bash","-lc",…]`).
 */
export function shellCommandOf(
  toolName: string,
  input: Record<string, unknown>
): string | undefined {
  const raw = input.command ?? input.cmd
  const command =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw) && raw.length > 0 && raw.every((part) => typeof part === "string")
        ? (raw as string[]).map(quoteArg).join(" ")
        : undefined
  if (!command || !command.trim()) return undefined
  const named = SHELL_TOOL_NAMES.has(toolName.toLowerCase())
  const shaped = Object.keys(input).every((key) => SHELL_ARG_KEYS.has(key))
  return named || shaped ? command : undefined
}

function isEditShaped(input: Record<string, unknown>): boolean {
  return (
    typeof input.old_string === "string" &&
    typeof input.new_string === "string" &&
    Object.keys(input).every((key) => EDIT_ARG_KEYS.has(key))
  )
}

function isMultiEditShaped(input: Record<string, unknown>): boolean {
  return (
    Array.isArray(input.edits) &&
    input.edits.length > 0 &&
    Object.keys(input).every((key) => key === "file_path" || key === "edits")
  )
}

function filePathOf(input: Record<string, unknown>): string | undefined {
  if (typeof input.file_path === "string") return input.file_path
  if (typeof input.path === "string") return input.path
  return undefined
}

function boundedJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2) ?? ""
  return json.length > JSON_PREVIEW_LIMIT ? `${json.slice(0, JSON_PREVIEW_LIMIT)}\n…` : json
}

/**
 * Tool-aware preview of the approval payload: shell commands render as a
 * bash block, edit/write payloads as a diff/content preview. Anything else
 * keeps the generic JSON dump — and an empty payload names the call instead
 * of showing a bare `{}`, which tells the user nothing about what they allow.
 */
export function ToolInputPreview({ approval }: { approval: PendingApproval }) {
  const t = useTranslations("chat.toolApproval")
  const name = bareToolName(approval.toolName)
  const input = (approval.input ?? {}) as Record<string, unknown>

  // A schedule write (built-in `schedule.*` skill): name the task and say the
  // schedule in words instead of dumping `{ "taskId": "…" }`.
  // The SDK's own permission prompt names it through the plugin-tools bridge.
  const scheduleName = name.replace(/^mcp__cognia-plugin-tools__/, "")
  if (isScheduleApprovalTool(scheduleName)) {
    return <ScheduledTaskApprovalPreview toolName={scheduleName} input={input} />
  }

  if (Object.keys(input).length === 0) {
    const label = approval.title || approval.displayName || approval.toolName
    return (
      <div data-testid="approval-input-fallback" className="space-y-1">
        <p className="break-all rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">
          {label}
        </p>
        <p className="text-xs text-muted-foreground">{t("noInputDetails")}</p>
      </div>
    )
  }

  const command = shellCommandOf(name, input)
  if (command !== undefined) {
    // Nothing the agent sent is hidden: arguments the block does not show
    // (timeout, cwd, …) are listed beneath it, because they change what runs.
    const rest = Object.fromEntries(
      Object.entries(input).filter(([key]) => !SHELL_SHOWN_KEYS.has(key))
    )
    return (
      <div data-testid="approval-bash-preview" className="space-y-1">
        <pre
          data-testid="approval-bash-command"
          className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed"
        >
          <code>{command}</code>
        </pre>
        {typeof input.description === "string" && input.description && (
          <p className="text-xs text-muted-foreground">{input.description}</p>
        )}
        {Object.keys(rest).length > 0 && (
          <div data-testid="approval-bash-extra">
            <CodeBlock code={boundedJson(rest)} language="json" />
          </div>
        )}
      </div>
    )
  }

  if (
    ((name === "edit" || name === "Edit") &&
      typeof input.old_string === "string" &&
      typeof input.new_string === "string") ||
    isEditShaped(input)
  ) {
    const filePath = filePathOf(input)
    return (
      <div data-testid="approval-edit-preview" className="space-y-1">
        {filePath && (
          <p className="break-all font-mono text-xs text-muted-foreground">{filePath}</p>
        )}
        <DiffPreview oldText={input.old_string as string} newText={input.new_string as string} />
      </div>
    )
  }

  if (
    ((name === "multi_edit" || name === "MultiEdit") && Array.isArray(input.edits)) ||
    isMultiEditShaped(input)
  ) {
    return (
      <div data-testid="approval-multi-edit-preview" className="space-y-1">
        {typeof input.file_path === "string" && (
          <p className="break-all font-mono text-xs text-muted-foreground">{input.file_path}</p>
        )}
        {(input.edits as Array<Record<string, unknown>>).map((e, i) => (
          <div key={i} className="space-y-1">
            {typeof input.file_path !== "string" && typeof e.file_path === "string" && (
              <p className="break-all font-mono text-xs text-muted-foreground">{e.file_path}</p>
            )}
            <DiffPreview
              oldText={typeof e.old_string === "string" ? e.old_string : ""}
              newText={typeof e.new_string === "string" ? e.new_string : ""}
            />
          </div>
        ))}
      </div>
    )
  }

  if (name === "apply_patch" && typeof input.patch === "string") {
    const files = applyPatchFiles(input)
    if (files.length > 0) {
      return (
        <div data-testid="approval-apply-patch-preview">
          <PatchFilesPreview files={files} />
        </div>
      )
    }
  }

  if ((name === "write" || name === "Write") && typeof input.content === "string") {
    return (
      <div data-testid="approval-write-preview" className="space-y-1">
        {typeof input.file_path === "string" && (
          <p className="break-all font-mono text-xs text-muted-foreground">{input.file_path}</p>
        )}
        <DiffPreview oldText="" newText={input.content.slice(0, WRITE_PREVIEW_LIMIT)} />
      </div>
    )
  }

  return <CodeBlock code={boundedJson(approval.input)} language="json" />
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
        // Honest terminal: the waiter is gone and the tool was already denied
        // — there is nothing left to answer, so Approve/Deny would be a lie.
        // "superseded" names the specific cause (a new instruction made the
        // ask stale) rather than the generic interruption wording.
        <p data-testid="approval-interrupted-notice" className="text-xs text-amber-600">
          {approval.interruptReason === "superseded"
            ? t("supersededNotice")
            : t("interruptedNotice")}
        </p>
      )}
    </div>
  )
}
