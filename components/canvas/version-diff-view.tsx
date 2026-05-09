"use client"

/**
 * Version Diff View — shows two snapshots side-by-side or inline,
 * with optional labels above each side and a stats badge bar
 * (`+N -M`) at the top so users can scan the change magnitude
 * before reading the diff.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { CanvasDocumentVersion } from "@/types/artifact/artifact"

interface VersionDiffViewProps {
  /** Cognia compatibility — raw old/new content. Either `before/after`
   * (versions) or `oldContent/newContent` (raw strings) may be passed. */
  before?: CanvasDocumentVersion | null
  after?: CanvasDocumentVersion | null
  oldContent?: string
  newContent?: string
  oldLabel?: string
  newLabel?: string
  mode?: "inline" | "side-by-side" | "unified"
  className?: string
}

interface DiffLine {
  type: "added" | "removed" | "unchanged"
  content: string
  oldLineNo?: number
  newLineNo?: number
}

function computeLineDiff(before: string, after: string): DiffLine[] {
  const beforeLines = before.split("\n")
  const afterLines = after.split("\n")
  const lines: DiffLine[] = []
  const max = Math.max(beforeLines.length, afterLines.length)
  let oldLine = 0
  let newLine = 0
  for (let i = 0; i < max; i += 1) {
    const b = beforeLines[i]
    const a = afterLines[i]
    if (b === undefined) {
      newLine += 1
      lines.push({ type: "added", content: a ?? "", newLineNo: newLine })
    } else if (a === undefined) {
      oldLine += 1
      lines.push({ type: "removed", content: b, oldLineNo: oldLine })
    } else if (a === b) {
      oldLine += 1
      newLine += 1
      lines.push({ type: "unchanged", content: a, oldLineNo: oldLine, newLineNo: newLine })
    } else {
      oldLine += 1
      lines.push({ type: "removed", content: b, oldLineNo: oldLine })
      newLine += 1
      lines.push({ type: "added", content: a, newLineNo: newLine })
    }
  }
  return lines
}

export function VersionDiffView({
  before,
  after,
  oldContent,
  newContent,
  oldLabel,
  newLabel,
  mode = "inline",
  className,
}: VersionDiffViewProps) {
  const t = useTranslations("canvas")
  const oldText = oldContent ?? before?.content ?? ""
  const newText = newContent ?? after?.content ?? ""
  const diff = useMemo(() => computeLineDiff(oldText, newText), [oldText, newText])
  const additions = useMemo(() => diff.filter((d) => d.type === "added").length, [diff])
  const removals = useMemo(() => diff.filter((d) => d.type === "removed").length, [diff])

  const headerStats = (
    <div className="flex items-center gap-2 px-2 py-1 text-[11px]">
      {(oldLabel || newLabel) && (
        <div className="flex flex-1 items-center gap-2 truncate">
          {oldLabel && <span className="truncate text-muted-foreground">{oldLabel}</span>}
          {oldLabel && newLabel && <span className="text-muted-foreground">→</span>}
          {newLabel && <span className="truncate font-medium">{newLabel}</span>}
        </div>
      )}
      <div className="ml-auto flex items-center gap-1">
        <Badge className="bg-success/10 text-[10px] text-success">+{additions}</Badge>
        <Badge className="bg-destructive/10 text-[10px] text-destructive">-{removals}</Badge>
      </div>
    </div>
  )

  if (mode === "side-by-side") {
    return (
      <div className={cn("flex flex-col text-xs font-mono", className)}>
        {headerStats}
        <div className="grid grid-cols-2 gap-2">
          <ScrollArea className="rounded border bg-muted/20 p-2">
            <pre className="whitespace-pre-wrap">{oldText}</pre>
          </ScrollArea>
          <ScrollArea className="rounded border bg-muted/20 p-2">
            <pre className="whitespace-pre-wrap">{newText}</pre>
          </ScrollArea>
        </div>
      </div>
    )
  }

  return (
    <div className={cn("flex flex-col rounded border font-mono text-xs", className)}>
      {headerStats}
      <ScrollArea>
        <div className="space-y-0 p-2 text-xs font-mono">
          {diff.length === 0 ? (
            <p className="px-2 py-3 text-center text-muted-foreground">{t("noChanges")}</p>
          ) : (
            diff.map((line, i) => (
              <div
                key={`${line.type}-${i}`}
                className={cn(
                  "flex items-baseline gap-2 rounded px-1 py-0.5",
                  line.type === "added" && "bg-success/10 text-success",
                  line.type === "removed" && "bg-destructive/10 text-destructive"
                )}
              >
                <span className="w-10 shrink-0 select-none text-right text-[10px] tabular-nums text-muted-foreground">
                  {line.oldLineNo ?? ""}
                  {line.oldLineNo && line.newLineNo ? "·" : " "}
                  {line.newLineNo ?? ""}
                </span>
                <Badge
                  className="size-5 shrink-0 px-0 text-center text-[10px] leading-5"
                  data-testid="diff-marker"
                >
                  {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
                </Badge>
                <span className="overflow-x-auto whitespace-pre">{line.content}</span>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

export default VersionDiffView
