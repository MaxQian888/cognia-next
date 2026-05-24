"use client"

import { useState, useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDown,
  ChevronRight,
  FileCode,
  WifiOff,
  Clock,
  KeyRound,
  Gauge,
  ServerCrash,
  CircleAlert,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { ParsedError, ParsedNode } from "@/lib/error-parsers/types"
import { normalizeErrorText, resolvePreset } from "@/lib/error-parsers"
import { LEVEL_THEME } from "@/lib/logging/level-theme"
import { JsonTree } from "@/components/shared/json-tree"
import { useFileViewerStore } from "@/stores/terminal/file-viewer-store"
import { Badge } from "@/components/ui/badge"

interface ErrorParsedViewProps {
  /** Pre-parsed result (legacy callers). When omitted, the view parses
   *  `rawError`/`rawText` itself via the resolved preset. */
  parsed?: ParsedError
  /** Raw text to show in the "raw" toggle; defaults to the normalized error. */
  rawText?: string
  /** Raw error to normalize + parse when `parsed` is not supplied. */
  rawError?: unknown
  /** Tool type used to resolve a tool-specific preset (e.g. `tool-Bash`). */
  toolType?: string
  /** Shown when the raw error normalizes to an empty string. */
  fallback?: string
}

export function ErrorParsedView({
  parsed,
  rawText,
  rawError,
  toolType,
  fallback,
}: ErrorParsedViewProps) {
  const t = useTranslations("chat.message")
  const [showParsed, setShowParsed] = useState(true)

  const text = rawText ?? normalizeErrorText(rawError, fallback)
  const computed = useMemo(() => resolvePreset(toolType).parse(text), [text, toolType])
  const result = parsed ?? computed

  const nodes = (
    <div className="space-y-1">
      {result.nodes.map((node, i) => (
        <ParsedNodeView key={i} node={node} />
      ))}
    </div>
  )

  // Nothing was recognised — render the text plainly, no raw/parsed toggle.
  if (!result.parsed) {
    return nodes
  }

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
        nodes
      ) : (
        <pre className="max-h-60 overflow-auto rounded bg-muted/40 p-2 text-[11px] font-mono leading-relaxed">
          {text}
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
    case "category":
      return <CategoryNodeView node={node} />
    case "ansi":
      return <AnsiNodeView node={node} />
    case "text":
    default:
      return <span className="text-sm whitespace-pre-wrap">{node.content}</span>
  }
}

// Stable category id → icon. A handful of grouped icons keeps the visual
// vocabulary small while still distinguishing network / timeout / auth /
// rate / server failures.
const CATEGORY_ICON: Record<string, LucideIcon> = {
  connectionRefused: WifiOff,
  connectionReset: WifiOff,
  dnsFailure: WifiOff,
  networkUnreachable: WifiOff,
  brokenPipe: WifiOff,
  fetchFailed: WifiOff,
  timeout: Clock,
  sessionTimeout: Clock,
  unauthorized: KeyRound,
  forbidden: KeyRound,
  rateLimited: Gauge,
  quotaExceeded: Gauge,
  modelOverloaded: Gauge,
  serverError: ServerCrash,
  serviceUnavailable: ServerCrash,
  sidecarExited: ServerCrash,
  dispatchFailed: ServerCrash,
}

// Hard / config failures read as destructive; transient / retryable ones as a
// warning. Unlisted categories fall back to warning.
const DESTRUCTIVE_CATEGORIES = new Set<string>([
  "connectionRefused",
  "dnsFailure",
  "unauthorized",
  "forbidden",
  "serverError",
  "serviceUnavailable",
  "sidecarExited",
  "providerMisconfigured",
  "modelRequired",
  "pluginToolMissing",
  "dispatchFailed",
])

function CategoryNodeView({ node }: { node: ParsedNode }) {
  const t = useTranslations("chat.message")
  const category = node.category ?? ""
  const Icon = CATEGORY_ICON[category] ?? CircleAlert
  const destructive = DESTRUCTIVE_CATEGORIES.has(category)
  const label = t.has(`errorCategory.${category}`) ? t(`errorCategory.${category}`) : node.content
  const hint = t.has(`errorCategoryHint.${category}`) ? t(`errorCategoryHint.${category}`) : ""

  return (
    <div className="space-y-1">
      <Badge
        className={cn(
          "gap-1 text-[10px]",
          destructive ? "bg-destructive/15 text-destructive" : "bg-warning/15 text-warning"
        )}
      >
        <Icon className="h-3 w-3" aria-hidden />
        {label}
      </Badge>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
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
  if (node.value === undefined) {
    return <span className="text-sm font-mono">{node.content}</span>
  }

  return (
    <div className="rounded border bg-muted/20 p-2">
      <JsonTree value={node.value} />
    </div>
  )
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

  return (
    <div className={cn("border-l-2 pl-2 text-sm font-mono whitespace-pre-wrap", gutterClass)}>
      {node.content}
    </div>
  )
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
  const t = useTranslations("chat.message")
  const status = node.status ?? 200
  const variant =
    status >= 200 && status < 300
      ? "bg-success/15 text-success"
      : status >= 300 && status < 400
        ? "bg-chart-3/15 text-chart-3"
        : status >= 400 && status < 500
          ? "bg-warning/15 text-warning"
          : "bg-destructive/15 text-destructive"

  const hint =
    node.category && t.has(`errorCategoryHint.${node.category}`)
      ? t(`errorCategoryHint.${node.category}`)
      : ""

  return (
    <div className="space-y-1">
      <Badge className={cn("text-[10px] font-mono", variant)}>{node.content}</Badge>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
