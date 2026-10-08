"use client"

// Body content for the core `apply_patch` tool: the unified diff it was handed,
// one section per file — what the change does to the file (created, deleted,
// renamed, modified), its path and counts, the hunks in the shared line view,
// and, once the patch has landed, the same "Open in review" route into the
// dock that Edit / Write offer. Rendered bare; the row above owns the chrome.

import { memo, useMemo } from "react"
import type { ToolUIPart } from "ai"
import { useTranslations } from "next-intl"
import { LineDiffView } from "@/components/diff/line-diff-view"
import { gitHunksToDiffRows } from "@/lib/git/diff-presentation"
import { parseUnifiedPatch, patchFilePath, type PatchFile } from "@/lib/git/unified-patch"
import { cn } from "@/lib/utils"
import { PreviewClampNote, TOOL_PREVIEW_MAX_EDITS, useClampedRows } from "./common"
import { WorkbenchReviewButton } from "./workbench-review-button"

/** Tallest one file's diff grows inside a tool row before it scrolls. */
export const APPLY_PATCH_FILE_MAX_HEIGHT = 240

/** Files an `apply_patch` call's input names, parsed once per payload. */
export function applyPatchFiles(input: unknown): PatchFile[] {
  const patch = (input as { patch?: unknown } | null | undefined)?.patch
  return typeof patch === "string" ? parseUnifiedPatch(patch) : []
}

const CHANGE_CLASS: Record<PatchFile["change"], string> = {
  added: "border-success/40 text-success",
  deleted: "border-destructive/40 text-destructive",
  renamed: "border-info/40 text-info",
  modified: "border-amber-500/40 text-amber-600 dark:text-amber-400",
}

export function ApplyPatchCard({ part, sessionId }: { part: ToolUIPart; sessionId?: string }) {
  const files = useMemo(() => applyPatchFiles(part.input), [part.input])
  // Review shows the working tree, so it only means something once the patch
  // was actually written. A one-file patch has the button on its row already.
  const reviewSessionId =
    part.state === "output-available" && files.length > 1 ? sessionId : undefined
  const resultText = typeof part.output === "string" ? part.output : undefined
  const resultFirstLine = useMemo(() => {
    if (resultText === undefined) return undefined
    const nl = resultText.indexOf("\n")
    return nl === -1 ? resultText : resultText.slice(0, nl)
  }, [resultText])

  if (files.length === 0) return null

  return (
    <div className="min-w-0 space-y-2" data-testid="mcp-apply-patch-card">
      <PatchFilesPreview files={files} reviewSessionId={reviewSessionId} />
      {resultText && (
        <p className="text-[11px] text-muted-foreground" data-testid="mcp-apply-patch-result">
          {resultFirstLine}
        </p>
      )}
    </div>
  )
}

/**
 * The files of a patch, one section each — shared by the tool row and the
 * approval prompt, which shows the same patch before it is allowed to land.
 */
export function PatchFilesPreview({
  files,
  reviewSessionId,
}: {
  files: PatchFile[]
  /** Offer "Open in review" per file (the patch has been applied). */
  reviewSessionId?: string
}) {
  const t = useTranslations("chat.mcp.applyPatch")
  const clamp = useClampedRows(files, TOOL_PREVIEW_MAX_EDITS)
  return (
    <div className="min-w-0 space-y-2" data-testid="mcp-apply-patch-files">
      {clamp.visible.map((file, i) => (
        <PatchFileSection
          key={`${patchFilePath(file) ?? ""}:${i}`}
          file={file}
          sessionId={reviewSessionId}
          changeLabel={t(`change.${file.change}`)}
          emptyLabel={file.binary ? t("binary") : t("noTextChanges")}
        />
      ))}
      {clamp.hidden > 0 && (
        <PreviewClampNote
          shown={clamp.shown}
          total={clamp.total}
          onExpand={clamp.reveal}
          testId="mcp-apply-patch-clamped"
        />
      )}
    </div>
  )
}

const PatchFileSection = memo(function PatchFileSection({
  file,
  sessionId,
  changeLabel,
  emptyLabel,
}: {
  file: PatchFile
  /** Set only once the patch landed: enables "Open in review". */
  sessionId?: string
  changeLabel: string
  emptyLabel: string
}) {
  const rows = useMemo(() => gitHunksToDiffRows(file.hunks), [file.hunks])
  const path = patchFilePath(file)
  return (
    <section
      className="overflow-hidden rounded border bg-muted/30"
      data-testid="mcp-apply-patch-file"
      data-change={file.change}
    >
      <header className="flex min-w-0 items-center gap-1.5 border-b px-2 py-0.5 text-[11px]">
        <span
          className={cn(
            "shrink-0 rounded-sm border px-1 text-[10px] font-semibold uppercase leading-4",
            CHANGE_CLASS[file.change]
          )}
        >
          {changeLabel}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono" title={path ?? undefined}>
          {file.change === "renamed" && file.oldPath && file.newPath
            ? `${file.oldPath} → ${file.newPath}`
            : path}
        </span>
        <span className="shrink-0 font-mono tabular-nums">
          <span className="text-success">+{file.added}</span>{" "}
          <span className="text-destructive">-{file.removed}</span>
        </span>
        {path ? <WorkbenchReviewButton sessionId={sessionId} absolutePath={path} /> : null}
      </header>
      {rows.length === 0 ? (
        <p className="px-2 py-1 text-[11px] text-muted-foreground">{emptyLabel}</p>
      ) : (
        <LineDiffView
          rows={rows}
          maxHeight={APPLY_PATCH_FILE_MAX_HEIGHT}
          aria-label={path ?? changeLabel}
          data-testid="mcp-apply-patch-lines"
        />
      )}
    </section>
  )
})
