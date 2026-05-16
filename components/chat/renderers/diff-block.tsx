"use client"

import { useState, memo, useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import { Copy, Check, Columns, Rows, Plus, Minus } from "lucide-react"
import { cn } from "@/lib/utils"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { useCopy } from "@/hooks/ui/use-copy"
import { loggers } from "@/lib/logger"

interface DiffLine {
  type: "add" | "remove" | "context" | "info"
  content: string
  oldLineNumber?: number
  newLineNumber?: number
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

  const parsedDiff = useMemo(() => parseDiff(content), [content])

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

  return (
    <div className={cn("group rounded-lg border overflow-hidden my-4 bg-muted/30", className)}>
      <div className="flex items-center justify-between px-3 py-2 bg-muted/80 border-b text-xs">
        <div className="flex items-center gap-3">
          <span className="font-mono font-medium">
            {filename || oldFilename || newFilename || t("defaultName")}
          </span>
          <div className="flex items-center gap-2 text-muted-foreground">
            <span className="flex items-center gap-0.5 text-green-600">
              <Plus className="h-3 w-3" />
              {stats.additions}
            </span>
            <span className="flex items-center gap-0.5 text-red-600">
              <Minus className="h-3 w-3" />
              {stats.deletions}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <TooltipIconButton
            variant="ghost"
            size="icon"
            className={cn("h-6 w-6", viewMode === "unified" && "bg-accent")}
            onClick={() => setViewMode("unified")}
            aria-label={t("unifiedView")}
            tooltip={t("unifiedView")}
          >
            <Rows className="h-3 w-3" />
          </TooltipIconButton>

          <TooltipIconButton
            variant="ghost"
            size="icon"
            className={cn("h-6 w-6", viewMode === "split" && "bg-accent")}
            onClick={() => setViewMode("split")}
            aria-label={t("splitView")}
            tooltip={t("splitView")}
          >
            <Columns className="h-3 w-3" />
          </TooltipIconButton>

          <TooltipIconButton
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={handleCopy}
            aria-label={t("copy")}
            tooltip={t("copy")}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </TooltipIconButton>
        </div>
      </div>

      <div className="overflow-x-auto">
        {viewMode === "unified" ? (
          <UnifiedDiffView lines={parsedDiff} />
        ) : (
          <SplitDiffView lines={parsedDiff} />
        )}
      </div>
    </div>
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
              line.type === "add" && "bg-green-500/10",
              line.type === "remove" && "bg-red-500/10",
              line.type === "info" && "bg-blue-500/10"
            )}
          >
            <td className="w-10 px-2 text-right text-muted-foreground select-none border-r border-muted">
              {line.oldLineNumber || ""}
            </td>
            <td className="w-10 px-2 text-right text-muted-foreground select-none border-r border-muted">
              {line.newLineNumber || ""}
            </td>
            <td className="w-4 text-center select-none">
              {line.type === "add" && <span className="text-green-600">+</span>}
              {line.type === "remove" && <span className="text-red-600">-</span>}
              {line.type === "info" && <span className="text-blue-600">@</span>}
            </td>
            <td
              className={cn(
                "px-2 py-0.5 whitespace-pre",
                line.type === "add" && "text-green-700 dark:text-green-400",
                line.type === "remove" && "text-red-700 dark:text-red-400",
                line.type === "info" && "text-blue-600 font-semibold"
              )}
            >
              {line.content}
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
                "w-1/2 border-r border-muted",
                pair.left?.type === "remove" && "bg-red-500/10",
                pair.left?.type === "info" && "bg-blue-500/10"
              )}
            >
              <div className="flex">
                <span className="w-10 px-2 text-right text-muted-foreground select-none border-r border-muted">
                  {pair.left?.oldLineNumber || ""}
                </span>
                <span className="w-4 text-center select-none">
                  {pair.left?.type === "remove" && <span className="text-red-600">-</span>}
                  {pair.left?.type === "info" && <span className="text-blue-600">@</span>}
                </span>
                <span
                  className={cn(
                    "flex-1 px-2 py-0.5 whitespace-pre",
                    pair.left?.type === "remove" && "text-red-700 dark:text-red-400",
                    pair.left?.type === "info" && "text-blue-600 font-semibold"
                  )}
                >
                  {pair.left?.content}
                </span>
              </div>
            </td>

            <td
              className={cn(
                "w-1/2",
                pair.right?.type === "add" && "bg-green-500/10",
                pair.right?.type === "info" && "bg-blue-500/10"
              )}
            >
              <div className="flex">
                <span className="w-10 px-2 text-right text-muted-foreground select-none border-r border-muted">
                  {pair.right?.newLineNumber || ""}
                </span>
                <span className="w-4 text-center select-none">
                  {pair.right?.type === "add" && <span className="text-green-600">+</span>}
                  {pair.right?.type === "info" && <span className="text-blue-600">@</span>}
                </span>
                <span
                  className={cn(
                    "flex-1 px-2 py-0.5 whitespace-pre",
                    pair.right?.type === "add" && "text-green-700 dark:text-green-400",
                    pair.right?.type === "info" && "text-blue-600 font-semibold"
                  )}
                >
                  {pair.right?.content}
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
