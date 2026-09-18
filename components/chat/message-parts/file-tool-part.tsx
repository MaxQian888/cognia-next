"use client"

/**
 * FileToolPart — a file-oriented tool call (Read / Write / Edit / MultiEdit /
 * Grep / Glob / LS / NotebookEdit) rendered as a single inline row in the
 * message stream, matching `TerminalToolPart`'s language: breathing status
 * dot, coloured verb, mono target (truncated), result meta, hover-revealed
 * copy / workbench actions, and a chevron that expands into the payload —
 * highlighted code for reads and writes, before/after diffs for edits, and
 * scrollable match lists for the search tools.
 *
 * Before this, every one of these tools stacked three bordered layers (Tool
 * card → McpCardShell → inner block). The row IS the call now; the expansion
 * renders the same bodies (`FileToolBody`, shared with `ToolDetailBody` so
 * simplified-mode `ToolCallRow` expansions stay identical) with no card of
 * their own.
 *
 * A failed call keeps the same row and shows the parsed error trace in the
 * expanded area, so `message-renderer` routes every state here.
 */

import { memo, useMemo, useState } from "react"
import type { ToolUIPart } from "ai"
import { useTranslations } from "next-intl"
import { ExternalLinkIcon } from "lucide-react"
import { toast } from "sonner"

import { Shimmer } from "@/components/ai-elements/shimmer"
import { ToolBody } from "@/components/ai-elements/tool"
import { FileTypeIcon } from "@/components/shared/file-type-icon"
import { Button } from "@/components/ui/button"
import { ToolSemanticBadges } from "@/components/chat/message-parts/tool-semantic-badges"
import {
  InlineCopyButton,
  ToolRowBlock,
  ToolRowShell,
} from "@/components/chat/message-parts/tool-row"
import { ErrorParsedView } from "@/components/error/error-parsed-view"
import { resultErrorPreview } from "@/lib/chat/tool-result-summary"
import { asString, resolveToolPartName } from "@/lib/chat/tool-summary"
import {
  canOfferWorkbenchReview,
  openFileInWorkbenchWorkspace,
} from "@/lib/files/edit-review-bridge"
import { parseOutputJson } from "@/components/chat/message-parts/mcp-renderers/common"
import { ReadCard } from "@/components/chat/message-parts/mcp-renderers/read-card"
import { WriteCard } from "@/components/chat/message-parts/mcp-renderers/write-card"
import { EditCard } from "@/components/chat/message-parts/mcp-renderers/edit-card"
import { GrepCard } from "@/components/chat/message-parts/mcp-renderers/grep-card"
import { GlobCard } from "@/components/chat/message-parts/mcp-renderers/glob-card"
import { LsCard } from "@/components/chat/message-parts/mcp-renderers/ls-card"
import { NotebookEditCard } from "@/components/chat/message-parts/mcp-renderers/notebook-edit-card"
import { WorkbenchReviewButton } from "@/components/chat/message-parts/mcp-renderers/workbench-review-button"
import { cn } from "@/lib/utils"

export type FileToolKind = "read" | "write" | "edit" | "grep" | "glob" | "ls" | "notebook"

/** Canonical kind per (namespace-folded, lower-cased) tool name. */
const KIND_BY_NAME: Record<string, FileToolKind> = {
  read: "read",
  write: "write",
  edit: "edit",
  multiedit: "edit",
  multi_edit: "edit",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  notebookedit: "notebook",
}

export function fileToolKind(part: { type?: string; toolName?: string }): FileToolKind | null {
  const name = resolveToolPartName(part)
  return name ? (KIND_BY_NAME[name.toLowerCase()] ?? null) : null
}

/** True for a tool call that the file row knows how to render. */
export function isFileToolPart(part: { type?: string; toolName?: string }): boolean {
  return fileToolKind(part) !== null
}

/* Verb labels are translated (`chat.fileTool.verb.*`) — the old cards
   rendered "读取" / "写入" in zh-CN, so the row keeps parity. */
const VERB_CLASS: Record<FileToolKind, string> = {
  read: "text-sky-600 dark:text-sky-400",
  write: "text-emerald-600 dark:text-emerald-400",
  edit: "text-amber-600 dark:text-amber-400",
  grep: "text-violet-600 dark:text-violet-400",
  glob: "text-violet-600 dark:text-violet-400",
  ls: "text-muted-foreground",
  notebook: "text-amber-600 dark:text-amber-400",
}

interface FileToolInfo {
  /** The row's mono target: path for file tools, pattern for searches. */
  target?: string
  /** Path used by the copy + workbench affordances (file tools only). */
  path?: string
  /** Read offset → the workbench link reveals this line. */
  line?: number
}

/** Target/path the row shows; undefined when the payload can't supply one. */
export function describeFileToolTarget(part: ToolUIPart, kind: FileToolKind): FileToolInfo {
  const input = (part.input ?? {}) as Record<string, unknown>
  switch (kind) {
    case "read": {
      const path = asString(input.file_path) ?? asString(input.path)
      const offset = typeof input.offset === "number" ? input.offset : undefined
      return { target: path, path, line: offset }
    }
    case "write":
    case "edit": {
      const path = asString(input.file_path) ?? asString(input.path)
      return { target: path, path }
    }
    case "notebook": {
      const path = asString(input.notebook_path) ?? asString(input.file_path)
      return { target: path, path }
    }
    case "grep": {
      // The body no longer echoes the query — the row target carries the
      // pattern, the scope, and a non-default output mode.
      const parts = [asString(input.pattern)]
      const scope = asString(input.glob) ?? asString(input.path)
      if (scope) parts.push(scope)
      const mode = asString(input.output_mode)
      if (mode) parts.push(mode)
      return { target: parts.filter(Boolean).join(" · ") || undefined }
    }
    case "glob": {
      const pattern = asString(input.pattern)
      const scope = asString(input.path)
      return { target: pattern ? (scope ? `${pattern} · ${scope}` : pattern) : scope }
    }
    case "ls": {
      const output = typeof part.output === "string" ? part.output : ""
      const firstLine = output.split(/\r?\n/).filter(Boolean)[0]
      const path = asString(input.path)
      return { target: path ?? firstLine, path: path ?? firstLine }
    }
  }
}

/** Result meta chip text for a settled call (line/match/edit counts). */
function fileToolResultMeta(
  part: ToolUIPart,
  kind: FileToolKind,
  t: ReturnType<typeof useTranslations>
): string | null {
  const input = (part.input ?? {}) as Record<string, unknown>
  const output = part.output
  const parsed = parseOutputJson(output) as Record<string, unknown> | null
  const outputLines = (text: unknown): number =>
    typeof text === "string" && text ? text.split(/\r?\n/).filter(Boolean).length : 0

  switch (kind) {
    case "read": {
      const content = asString(parsed?.content) ?? (typeof output === "string" ? output : "")
      const n = Array.isArray(parsed?.lines) ? parsed.lines.length : outputLines(content)
      return n > 0 ? t("result.lines", { count: n }) : null
    }
    case "write": {
      const n = outputLines(input.content)
      return n > 0 ? t("result.lines", { count: n }) : null
    }
    case "edit": {
      const n = Array.isArray(input.edits) ? input.edits.length : input.old_string ? 1 : 0
      return n > 0 ? t("result.edits", { count: n }) : null
    }
    case "grep": {
      const list = parsed?.matches ?? parsed?.lines ?? parsed?.files
      const n = Array.isArray(list) ? list.length : outputLines(output)
      return n > 0 ? t("result.matches", { count: n }) : null
    }
    case "glob": {
      const list = parsed?.matches ?? parsed?.files
      const n = Array.isArray(list) ? list.length : outputLines(output)
      return n > 0 ? t("result.files", { count: n }) : null
    }
    case "ls": {
      // First output line is the directory itself; entries are the rest.
      const n = Math.max(outputLines(output) - 1, 0)
      return n > 0 ? t("result.entries", { count: n }) : null
    }
    case "notebook": {
      const meta = [
        asString(input.edit_mode),
        asString(input.cell_type),
        input.cell_id ? `cell ${input.cell_id}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ")
      return meta || null
    }
  }
}

/** Splits a path into a muted dirname and the basename the eye looks for. */
function PathTarget({ path }: { path: string }) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  if (cut <= 0) return <>{path}</>
  return (
    <>
      <span className="text-muted-foreground">{path.slice(0, cut + 1)}</span>
      {path.slice(cut + 1)}
    </>
  )
}

/** Row action that opens the reported file in the workspace panel. */
const OpenInWorkspaceButton = memo(function OpenInWorkspaceButton({
  sessionId,
  path,
  line,
}: {
  sessionId?: string
  path: string
  line?: number
}) {
  const t = useTranslations("chat.mcp")
  if (!sessionId || !canOfferWorkbenchReview() || path.trim() === "") return null
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-6 text-muted-foreground hover:text-foreground"
      aria-label={t("openInWorkspace")}
      title={t("openInWorkspace")}
      data-testid="file-tool-open-in-workspace"
      onClick={(e) => {
        e.stopPropagation()
        void openFileInWorkbenchWorkspace({ sessionId, path, line }).then((opened) => {
          if (!opened) toast.error(t("openInWorkspaceOutOfScope"))
        })
      }}
    >
      <ExternalLinkIcon className="size-3" />
    </Button>
  )
})

type BodyComponent = (props: { part: ToolUIPart; sessionId?: string }) => React.JSX.Element | null

const BODY_BY_KIND: Record<FileToolKind, BodyComponent> = {
  read: ReadCard,
  write: WriteCard,
  edit: EditCard,
  grep: GrepCard,
  glob: GlobCard,
  ls: LsCard,
  notebook: NotebookEditCard,
}

export interface FileToolBodyProps {
  part: ToolUIPart
  sessionId?: string
}

/**
 * The payload view under the row — shared by `FileToolPart` (standard /
 * detailed modes) and `ToolDetailBody` (simplified `ToolCallRow` expansions).
 * Errors render the parsed trace; a payload the per-kind body rejects falls
 * back to the generic input/output body so the expansion never goes blank.
 */
export function FileToolBody({ part, sessionId }: FileToolBodyProps) {
  const t = useTranslations("chat.toolRow")
  if (part.state === "output-error") {
    const rawError = (part as { errorText?: unknown }).errorText ?? part.output
    return (
      <ToolRowBlock label={t("errorLabel")} mono={false} testId="file-tool-error">
        <div className="px-2.5 py-1.5 font-sans text-sm">
          <ErrorParsedView rawError={rawError} toolType={part.type} fallback={t("errorLabel")} />
        </div>
      </ToolRowBlock>
    )
  }
  const kind = fileToolKind(part)
  const Body = kind ? BODY_BY_KIND[kind] : undefined
  const rendered = Body ? Body({ part, sessionId }) : null
  return rendered ?? <ToolBody part={part} />
}

export interface FileToolPartProps {
  part: ToolUIPart
  sessionId?: string
  /**
   * Seeds the row's open state at mount (read once, like a Collapsible's
   * `defaultOpen`). Set by the activity group's expand-all / collapse-all and
   * by `detailed` mode; when absent a running or failed call starts open.
   */
  defaultOpen?: boolean
}

export const FileToolPart = memo(function FileToolPart({
  part,
  sessionId,
  defaultOpen,
}: FileToolPartProps) {
  const t = useTranslations("chat.toolRow")
  const tFlow = useTranslations("chat.agentFlow")
  const running = part.state === "input-available"
  const [open, setOpen] = useState(defaultOpen ?? (running || part.state === "output-error"))

  const kind = fileToolKind(part)
  const info = useMemo(() => (kind ? describeFileToolTarget(part, kind) : {}), [part, kind])
  const verbLabel = t(`verb.${kind ?? "read"}`)
  const verbClass = VERB_CLASS[kind ?? "read"]

  const readOnlyHint = (part as ToolUIPart & { toolMetadata?: { readOnlyHint?: boolean | null } })
    .toolMetadata?.readOnlyHint

  const meta = useMemo((): { text: string; isError?: boolean } | null => {
    switch (part.state) {
      case "input-available":
        return { text: tFlow("status.running") }
      case "approval-requested":
        return { text: tFlow("status.awaitingApproval") }
      case "output-denied":
        return { text: tFlow("status.denied") }
      case "output-error": {
        const preview = resultErrorPreview(
          (part as { errorText?: unknown }).errorText ?? part.output
        )
        return { text: preview || tFlow("status.error"), isError: true }
      }
      case "output-available": {
        const text = kind ? fileToolResultMeta(part, kind, tFlow) : null
        return text ? { text } : null
      }
      default:
        return null
    }
  }, [part, kind, tFlow])

  const copyValue = info.path ?? info.target
  const writable = kind === "write" || kind === "edit"
  const statusKey: Record<ToolUIPart["state"], string> = {
    "input-streaming": "pending",
    "input-available": "running",
    "approval-requested": "awaitingApproval",
    "approval-responded": "responded",
    "output-available": "completed",
    "output-denied": "denied",
    "output-error": "error",
  }

  return (
    <ToolRowShell
      status={part.state}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      ariaLabel={t("rowAria", {
        verb: verbLabel,
        target: info.target ?? "",
        status: tFlow(`status.${statusKey[part.state]}`),
      })}
      title={info.target}
      testId="file-tool-part"
      dataKind={kind ?? undefined}
      lead={
        <span
          className={cn("shrink-0 text-[11px] font-semibold uppercase tracking-wide", verbClass)}
        >
          {verbLabel}
        </span>
      }
      icon={
        info.path ? (
          // The file-type glyph the rest of the app shows beside a path
          // (plugin icon theme on desktop, built-in tones elsewhere). A
          // search tool's target is a pattern, not a file — no icon.
          <FileTypeIcon path={info.path} isDir={kind === "ls"} className="size-3.5 shrink-0" />
        ) : undefined
      }
      target={
        running && info.target ? (
          <Shimmer as="span" className="min-w-0 flex-1 truncate font-mono text-xs" duration={1.6}>
            {info.target}
          </Shimmer>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
            {info.path ? <PathTarget path={info.path} /> : (info.target ?? verbLabel)}
          </span>
        )
      }
      badges={<ToolSemanticBadges readOnlyHint={readOnlyHint} />}
      meta={
        meta ? (
          <span
            className={cn(
              "shrink-0 truncate text-[11px]",
              meta.isError ? "text-destructive" : "text-muted-foreground"
            )}
            data-testid="file-tool-meta"
          >
            {meta.text}
          </span>
        ) : undefined
      }
      actions={
        copyValue ? (
          <>
            <InlineCopyButton
              value={copyValue}
              label={t("copyTarget")}
              testId="file-tool-copy-target"
            />
            {writable && info.path ? (
              <WorkbenchReviewButton sessionId={sessionId} absolutePath={info.path} />
            ) : info.path ? (
              <OpenInWorkspaceButton sessionId={sessionId} path={info.path} line={info.line} />
            ) : null}
          </>
        ) : undefined
      }
    >
      <FileToolBody part={part} sessionId={sessionId} />
    </ToolRowShell>
  )
})

export default FileToolPart
