"use client"

import { useState, memo, useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import { Columns, FileDiff, Minus, Plus, Rows } from "lucide-react"
import { CopyFeedbackIcon } from "@/components/shared/animated-action-icon"
import { cn } from "@/lib/utils"
import { RichBlockAction } from "@/components/chat/renderers/rich-block/rich-block-action"
import { RichBlockFrame } from "@/components/chat/renderers/rich-block/rich-block-frame"
import { useCopy } from "@/hooks/ui/use-copy"
import { loggers } from "@cognia/logging"
import { computeIntralineDiff, type IntralineSegment } from "@/lib/chat/intraline-diff"

interface DiffLine {
  type: "add" | "remove" | "context" | "info"
  content: string
  oldLineNumber?: number
  newLineNumber?: number
  /** Word/char-level segments, set on a remove→add modification pair. */
  segments?: IntralineSegment[]
}

/** Render a line's intraline segments (changed runs emphasized) or plain text. */
function IntralineContent({
  segments,
  content,
  emphasis,
}: {
  segments: IntralineSegment[] | undefined
  content: string
  emphasis: string
}) {
  if (!segments) return <>{content}</>
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === "equal" ? (
          <span key={i}>{seg.value}</span>
        ) : (
          <span key={i} className={cn("rounded-sm", emphasis)} data-testid="diff-intraline">
            {seg.value}
          </span>
        )
      )}
    </>
  )
}

/**
 * Attach intraline segments to each remove line immediately followed by an add
 * line (a single-line modification). Best-effort: only the adjacent pair is
 * annotated, so multi-line edits highlight at their boundary and degrade to
 * whole-line color elsewhere.
 */
function annotateIntraline(lines: DiffLine[]): DiffLine[] {
  const out = lines.map((l) => ({ ...l }))
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i].type === "remove" && out[i + 1].type === "add") {
      const d = computeIntralineDiff(out[i].content, out[i + 1].content)
      if (d) {
        out[i].segments = d.removed
        out[i + 1].segments = d.added
      }
    }
  }
  return out
}

interface DiffBlockProps {
  content: string
  language?: string
  className?: string
  filename?: string
  oldFilename?: string
  newFilename?: string
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

  const parsedDiff = useMemo(() => annotateIntraline(parseDiff(content)), [content])

  const handleCopy = useCallback(async () => {
    await copy(content)
  }, [content, copy])

  const stats = useMemo(() => {
    let additions = 0
    let deletions = 0
    for (const line of parsedDiff) {
      if (line.type === "add") additions++
      if (line.type === "remove") deletions++
    }
    return { additions, deletions }
  }, [parsedDiff])

  // The shared block frame (ADR-0218); it also brings the rich-controls
  // reveal this toolbar used to lack.
  return (
    <RichBlockFrame
      kind="diff"
      className={className}
      icon={<FileDiff />}
      label={
        <span className="font-mono">
          {filename || oldFilename || newFilename || t("defaultName")}
        </span>
      }
      meta={
        <span className="flex items-center gap-2 tabular-nums">
          <span className="flex items-center gap-0.5 text-success">
            <Plus className="size-3" />
            {stats.additions}
          </span>
          <span className="flex items-center gap-0.5 text-destructive">
            <Minus className="size-3" />
            {stats.deletions}
          </span>
        </span>
      }
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
      bodyClassName="overflow-x-auto bg-muted/30"
    >
      {viewMode === "unified" ? (
        <UnifiedDiffView lines={parsedDiff} />
      ) : (
        <SplitDiffView lines={parsedDiff} />
      )}
    </RichBlockFrame>
  )
})

const UnifiedDiffView = memo(function UnifiedDiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <table className="w-full text-xs font-mono">
      <tbody>
        {lines.map((line, index) => (
          <tr
            key={index}
            className={cn(
              line.type === "add" && "bg-success/10",
              line.type === "remove" && "bg-destructive/10",
              line.type === "info" && "bg-info/10"
            )}
          >
            <td className="w-10 px-2 text-right text-muted-foreground select-none border-r border-border/60">
              {line.oldLineNumber || ""}
            </td>
            <td className="w-10 px-2 text-right text-muted-foreground select-none border-r border-border/60">
              {line.newLineNumber || ""}
            </td>
            <td className="w-4 text-center select-none">
              {line.type === "add" && <span className="text-success">+</span>}
              {line.type === "remove" && <span className="text-destructive">-</span>}
              {line.type === "info" && <span className="text-info">@</span>}
            </td>
            <td
              className={cn(
                "px-2 py-0.5 whitespace-pre",
                line.type === "add" && "text-success",
                line.type === "remove" && "text-destructive",
                line.type === "info" && "text-info font-semibold"
              )}
            >
              <IntralineContent
                segments={line.segments}
                content={line.content}
                emphasis={line.type === "add" ? "bg-success/25" : "bg-destructive/20"}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
})

const SplitDiffView = memo(function SplitDiffView({ lines }: { lines: DiffLine[] }) {
  const pairs = useMemo(() => {
    const result: { left?: DiffLine; right?: DiffLine }[] = []
    let i = 0

    while (i < lines.length) {
      const line = lines[i]

      if (line.type === "context" || line.type === "info") {
        result.push({ left: line, right: line })
        i++
      } else if (line.type === "remove") {
        const nextLine = lines[i + 1]
        if (nextLine?.type === "add") {
          result.push({ left: line, right: nextLine })
          i += 2
        } else {
          result.push({ left: line, right: undefined })
          i++
        }
      } else if (line.type === "add") {
        result.push({ left: undefined, right: line })
        i++
      } else {
        i++
      }
    }

    return result
  }, [lines])

  return (
    <table className="w-full text-xs font-mono">
      <tbody>
        {pairs.map((pair, index) => (
          <tr key={index}>
            <td
              className={cn(
                "w-1/2 border-r border-border/60",
                pair.left?.type === "remove" && "bg-destructive/10",
                pair.left?.type === "info" && "bg-info/10"
              )}
            >
              <div className="flex">
                <span className="w-10 px-2 text-right text-muted-foreground select-none border-r border-border/60">
                  {pair.left?.oldLineNumber || ""}
                </span>
                <span className="w-4 text-center select-none">
                  {pair.left?.type === "remove" && <span className="text-destructive">-</span>}
                  {pair.left?.type === "info" && <span className="text-info">@</span>}
                </span>
                <span
                  className={cn(
                    "flex-1 px-2 py-0.5 whitespace-pre",
                    pair.left?.type === "remove" && "text-destructive",
                    pair.left?.type === "info" && "text-info font-semibold"
                  )}
                >
                  <IntralineContent
                    segments={pair.left?.segments}
                    content={pair.left?.content ?? ""}
                    emphasis="bg-destructive/20"
                  />
                </span>
              </div>
            </td>

            <td
              className={cn(
                "w-1/2",
                pair.right?.type === "add" && "bg-success/10",
                pair.right?.type === "info" && "bg-info/10"
              )}
            >
              <div className="flex">
                <span className="w-10 px-2 text-right text-muted-foreground select-none border-r border-border/60">
                  {pair.right?.newLineNumber || ""}
                </span>
                <span className="w-4 text-center select-none">
                  {pair.right?.type === "add" && <span className="text-success">+</span>}
                  {pair.right?.type === "info" && <span className="text-info">@</span>}
                </span>
                <span
                  className={cn(
                    "flex-1 px-2 py-0.5 whitespace-pre",
                    pair.right?.type === "add" && "text-success",
                    pair.right?.type === "info" && "text-info font-semibold"
                  )}
                >
                  <IntralineContent
                    segments={pair.right?.segments}
                    content={pair.right?.content ?? ""}
                    emphasis="bg-success/25"
                  />
                </span>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
})

function parseDiff(content: string): DiffLine[] {
  const lines = content.split("\n")
  const result: DiffLine[] = []
  let oldLineNum = 0
  let newLineNum = 0

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunkMatch) {
      oldLineNum = parseInt(hunkMatch[1], 10)
      newLineNum = parseInt(hunkMatch[2], 10)
      result.push({ type: "info", content: line })
      continue
    }

    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ")) {
      continue
    }

    if (line.startsWith("+")) {
      result.push({
        type: "add",
        content: line.slice(1),
        newLineNumber: newLineNum++,
      })
      continue
    }

    if (line.startsWith("-")) {
      result.push({
        type: "remove",
        content: line.slice(1),
        oldLineNumber: oldLineNum++,
      })
      continue
    }

    if (line.startsWith(" ") || line === "") {
      result.push({
        type: "context",
        content: line.slice(1) || "",
        oldLineNumber: oldLineNum++,
        newLineNumber: newLineNum++,
      })
    }
  }

  return result
}

export default DiffBlock
