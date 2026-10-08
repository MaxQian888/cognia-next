"use client"

/**
 * DiffBlock — a ```diff code block (and the tool / remote-session bodies that
 * hand it a patch), in the shared rich-block frame.
 *
 * Parsing is `parseUnifiedPatch` and drawing is `LineDiffView`: the same
 * parser an agent's `apply_patch` call renders through and the same
 * virtualized view the dock uses for git hunks. Before, this block carried a
 * parser and two `<table>` renderers of its own that mounted one row per line,
 * so a pasted lockfile diff mounted thousands of rows inside a message.
 *
 * A patch that spans several files shows one section per file, each with its
 * path and counts; unified / split is one toggle for the whole block.
 */

import { memo, useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Columns, FileDiff, Minus, Plus, Rows } from "lucide-react"
import { CopyFeedbackIcon } from "@/components/shared/animated-action-icon"
import { cn } from "@/lib/utils"
import { RichBlockAction } from "@/components/chat/renderers/rich-block/rich-block-action"
import { RichBlockFrame } from "@/components/chat/renderers/rich-block/rich-block-frame"
import { LineDiffView } from "@/components/diff/line-diff-view"
import { useCopy } from "@/hooks/ui/use-copy"
import { loggers } from "@cognia/logging"
import { gitHunksToDiffRows } from "@/lib/git/diff-presentation"
import { parseUnifiedPatch, patchFilePath, type PatchFile } from "@/lib/git/unified-patch"

/** Tallest a single file's diff grows inside a message before it scrolls. */
export const DIFF_BLOCK_MAX_HEIGHT = 480

interface DiffBlockProps {
  content: string
  language?: string
  className?: string
  filename?: string
  oldFilename?: string
  newFilename?: string
}

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="flex items-center gap-2 tabular-nums">
      <span className="flex items-center gap-0.5 text-success">
        <Plus className="size-3" />
        {added}
      </span>
      <span className="flex items-center gap-0.5 text-destructive">
        <Minus className="size-3" />
        {removed}
      </span>
    </span>
  )
}

export const DiffBlock = memo(function DiffBlock({
  content,
  className,
  filename,
  oldFilename,
  newFilename,
}: DiffBlockProps) {
  const t = useTranslations("chat.renderers.diff")
  const [viewMode, setViewMode] = useState<"unified" | "split">("unified")
  const { copied, copy } = useCopy({ logger: loggers.chat, scope: "chat" })

  const files = useMemo(() => parseUnifiedPatch(content), [content])
  const stats = useMemo(() => {
    let added = 0
    let removed = 0
    for (const file of files) {
      added += file.added
      removed += file.removed
    }
    return { added, removed }
  }, [files])

  const handleCopy = useCallback(async () => {
    await copy(content)
  }, [content, copy])

  const single = files.length <= 1
  const label =
    filename ||
    oldFilename ||
    newFilename ||
    (single && files[0] ? patchFilePath(files[0]) : null) ||
    (single ? t("defaultName") : t("fileCount", { count: files.length }))

  // The shared block frame (ADR-0218); it also brings the rich-controls
  // reveal this toolbar used to lack.
  return (
    <RichBlockFrame
      kind="diff"
      className={className}
      icon={<FileDiff />}
      label={<span className="font-mono">{label}</span>}
      meta={<Counts added={stats.added} removed={stats.removed} />}
      actions={
        <>
          <RichBlockAction
            label={t("unifiedView")}
            aria-pressed={viewMode === "unified"}
            className={cn(viewMode === "unified" && "bg-accent text-foreground")}
            onClick={() => setViewMode("unified")}
          >
            <Rows />
          </RichBlockAction>
          <RichBlockAction
            label={t("splitView")}
            aria-pressed={viewMode === "split"}
            className={cn(viewMode === "split" && "bg-accent text-foreground")}
            onClick={() => setViewMode("split")}
          >
            <Columns />
          </RichBlockAction>
          <RichBlockAction label={t("copy")} onClick={handleCopy}>
            <CopyFeedbackIcon copied={copied} size={12} />
          </RichBlockAction>
        </>
      }
      bodyClassName="bg-muted/30"
    >
      {files.length === 0 ? (
        // Not a diff after all: show what was written rather than nothing.
        <pre className="overflow-x-auto px-3 py-2 font-mono text-xs" data-testid="diff-block-raw">
          {content}
        </pre>
      ) : (
        <div className="divide-y divide-border/60">
          {files.map((file, i) => (
            <DiffBlockFile
              key={i}
              file={file}
              layout={viewMode}
              showHeader={!single}
              label={label}
              emptyLabel={file.binary ? t("binary") : t("noTextChanges")}
            />
          ))}
        </div>
      )}
    </RichBlockFrame>
  )
})

const DiffBlockFile = memo(function DiffBlockFile({
  file,
  layout,
  showHeader,
  label,
  emptyLabel,
}: {
  file: PatchFile
  layout: "unified" | "split"
  showHeader: boolean
  label: string
  /** Shown instead of lines: a binary file, or a rename / mode change only. */
  emptyLabel: string
}) {
  const rows = useMemo(() => gitHunksToDiffRows(file.hunks), [file.hunks])
  const path = patchFilePath(file)
  return (
    <section data-testid="diff-block-file" data-change={file.change}>
      {showHeader ? (
        <header className="flex items-center gap-2 bg-muted/50 px-2 py-1 text-[11px]">
          <span className="min-w-0 flex-1 truncate font-mono" title={path ?? undefined}>
            {file.change === "renamed" && file.oldPath && file.newPath
              ? `${file.oldPath} → ${file.newPath}`
              : path}
          </span>
          <Counts added={file.added} removed={file.removed} />
        </header>
      ) : null}
      {file.binary || rows.length === 0 ? (
        <p className="px-3 py-1.5 text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <LineDiffView
          rows={rows}
          layout={layout}
          maxHeight={DIFF_BLOCK_MAX_HEIGHT}
          aria-label={path ?? label}
          data-testid="diff-block-lines"
        />
      )}
    </section>
  )
})

export default DiffBlock
