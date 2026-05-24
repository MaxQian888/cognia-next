"use client"

import { useState, useCallback } from "react"
import { useTranslations } from "next-intl"
import { ChevronDown, ChevronRight, FileCode } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ParsedError, ParsedNode } from "@/lib/error-parsers/types"
import { LEVEL_THEME } from "@/lib/logging/level-theme"
import { JsonTree } from "@/components/shared/json-tree"
import { useFileViewerStore } from "@/stores/terminal/file-viewer-store"
import { Badge } from "@/components/ui/badge"

interface ErrorParsedViewProps {
  parsed: ParsedError
  rawText: string
}

export function ErrorParsedView({ parsed, rawText }: ErrorParsedViewProps) {
  const t = useTranslations("chat.message")
  const [showParsed, setShowParsed] = useState(true)

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setShowParsed((v) => !v)}
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        data-testid="error-parsed-toggle"
      >
        {showParsed ? (
          <ChevronDown className="h-3 w-3" aria-hidden />
        ) : (
          <ChevronRight className="h-3 w-3" aria-hidden />
        )}
        {showParsed ? t("showRaw") : t("showParsed")}
      </button>

      {showParsed ? (
        <div className="space-y-1">
          {parsed.nodes.map((node, i) => (
            <ParsedNodeView key={i} node={node} />
          ))}
        </div>
      ) : (
        <pre className="max-h-60 overflow-auto rounded bg-muted/40 p-2 text-[11px] font-mono leading-relaxed">
          {rawText}
        </pre>
      )}
    </div>
  )
}

function ParsedNodeView({ node }: { node: ParsedNode }) {
  switch (node.kind) {
    case "json":
      return <JsonNodeView node={node} />
    case "stack":
      return <StackNodeView node={node} />
    case "log":
      return <LogNodeView node={node} />
    case "url":
      return <UrlNodeView node={node} />
    case "path":
      return <PathNodeView node={node} />
    case "exitCode":
      return <ExitCodeNodeView node={node} />
    case "statusCode":
      return <StatusCodeNodeView node={node} />
    case "ansi":
      return <AnsiNodeView node={node} />
    case "text":
    default:
      return <span className="text-sm whitespace-pre-wrap">{node.content}</span>
  }
}

function AnsiNodeView({ node }: { node: ParsedNode }) {
  if (!node.segments || node.segments.length === 0) {
    return <span className="text-sm whitespace-pre-wrap font-mono">{node.content}</span>
  }
  return (
    <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-[11px] font-mono leading-relaxed">
      {node.segments.map((seg, i) => (
        <span key={i} className={seg.className}>
          {seg.text}
        </span>
      ))}
    </pre>
  )
}

function JsonNodeView({ node }: { node: ParsedNode }) {
  if (!node.children || node.children.length === 0) {
    return <span className="text-sm font-mono">{node.content}</span>
  }

  return (
    <div className="rounded border bg-muted/20 p-2">
      <JsonTree value={rebuildJsonFromNodes(node.children)} />
    </div>
  )
}

function rebuildJsonFromNodes(nodes: ParsedNode[]): unknown {
  const result: Record<string, unknown> = {}
  for (const node of nodes) {
    const match = node.content.match(/^\["?(\w+)"?\]:\s*(.*)$/)
    if (match) {
      const key = match[1]
      const valStr = match[2]
      if (node.children && node.children.length > 0) {
        result[key] = rebuildJsonFromNodes(node.children)
      } else {
        result[key] = parsePrimitive(valStr)
      }
    }
  }
  return result
}

function parsePrimitive(s: string): unknown {
  const trimmed = s.trim()
  if (trimmed === "null") return null
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed)
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function StackNodeView({ node }: { node: ParsedNode }) {
  const openFile = useFileViewerStore((s) => s.openFile)

  const handlePathClick = useCallback(
    (path: string, line: number | null, col: number | null) => {
      openFile(path, line, col)
    },
    [openFile]
  )

  if (!node.frames || node.frames.length === 0) {
    return <span className="text-sm">{node.content}</span>
  }

  return (
    <div className="space-y-1">
      {node.frames.map((frame, i) => (
        <div key={i} className="flex items-center gap-1 text-[11px] font-mono">
          <span className="text-muted-foreground">at</span>
          {frame.fn && frame.fn !== "<anonymous>" && (
            <span className="text-chart-4">{frame.fn}</span>
          )}
          <button
            type="button"
            className="inline-flex items-center gap-0.5 text-primary hover:underline"
            onClick={() => handlePathClick(frame.file, frame.line, frame.col)}
          >
            <FileCode className="h-3 w-3" />
            {frame.file}:{frame.line ?? "?"}:{frame.col ?? "?"}
          </button>
        </div>
      ))}
    </div>
  )
}

function LogNodeView({ node }: { node: ParsedNode }) {
  const level = node.level ?? "info"
  const gutterClass = LEVEL_THEME[level]?.gutterClass ?? "border-l-transparent"

  return <div className={cn("border-l-2 pl-2 text-sm font-mono", gutterClass)}>{node.content}</div>
}

function UrlNodeView({ node }: { node: ParsedNode }) {
  return (
    <a
      href={node.href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-sm text-primary hover:underline"
    >
      {node.content}
    </a>
  )
}

function PathNodeView({ node }: { node: ParsedNode }) {
  const openFile = useFileViewerStore((s) => s.openFile)

  const handleClick = useCallback(() => {
    if (node.href) {
      openFile(node.href, node.line ?? null, node.column ?? null)
    }
  }, [node.href, node.line, node.column, openFile])

  return (
    <button
      type="button"
      className="inline-flex items-center gap-0.5 text-sm font-mono text-primary hover:underline"
      onClick={handleClick}
    >
      <FileCode className="h-3 w-3" />
      {node.content}
    </button>
  )
}

function ExitCodeNodeView({ node }: { node: ParsedNode }) {
  const code = node.exitCode ?? 0
  const variant =
    code === 0
      ? "bg-success/15 text-success"
      : code >= 128
        ? "bg-warning/15 text-warning"
        : "bg-destructive/15 text-destructive"

  return <Badge className={cn("text-[10px] font-mono", variant)}>{node.content}</Badge>
}

function StatusCodeNodeView({ node }: { node: ParsedNode }) {
  const status = node.status ?? 200
  const variant =
    status >= 200 && status < 300
      ? "bg-success/15 text-success"
      : status >= 300 && status < 400
        ? "bg-chart-3/15 text-chart-3"
        : status >= 400 && status < 500
          ? "bg-warning/15 text-warning"
          : "bg-destructive/15 text-destructive"

  return <Badge className={cn("text-[10px] font-mono", variant)}>{node.content}</Badge>
}
