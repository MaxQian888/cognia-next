"use client"

// Structured card for the core `edit` and `multi_edit` tools (and SDK
// `Edit`/`MultiEdit` payloads, which share the same input shape). Shows the
// target path and a before/after diff per edit.

import { useTranslations } from "next-intl"
import { FilePenLineIcon } from "lucide-react"
import type { ToolUIPart } from "ai"
import { McpCardShell } from "./common"
import { DiffPreview } from "./diff-preview"

interface EditEntry {
  old_string?: string
  new_string?: string
  replace_all?: boolean
}

interface EditInput extends EditEntry {
  file_path?: string
  path?: string
  edits?: EditEntry[]
}

export function EditCard({ part }: { part: ToolUIPart }) {
  const t = useTranslations("chat.mcp.edit")
  const input = (part.input ?? {}) as EditInput
  const path = input.file_path ?? input.path
  if (!path) return null

  const edits: EditEntry[] = Array.isArray(input.edits)
    ? input.edits
    : typeof input.old_string === "string"
      ? [input]
      : []
  if (edits.length === 0) return null

  const resultText = typeof part.output === "string" ? part.output : undefined

  return (
    <McpCardShell title={t("title")} badge={path} testId="mcp-edit-card">
      <div className="flex items-start gap-2">
        <FilePenLineIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="font-mono text-[11px] text-muted-foreground" data-testid="mcp-edit-path">
            {path}
            {edits.length > 1 && ` · ${t("editCount", { count: edits.length })}`}
          </p>
          {edits.map((e, i) => (
            <DiffPreview key={i} oldText={e.old_string ?? ""} newText={e.new_string ?? ""} />
          ))}
          {resultText && (
            <p className="text-[11px] text-muted-foreground" data-testid="mcp-edit-result">
              {resultText.split("\n")[0]}
            </p>
          )}
        </div>
      </div>
    </McpCardShell>
  )
}
