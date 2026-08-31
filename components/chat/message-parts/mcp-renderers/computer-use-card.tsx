"use client"

/**
 * Inline renderer for the app-session Computer Use tools (ADR-0020).
 *
 * This card used to be registered for a `computer_use` tool that no longer
 * exists, and parsed a payload shape (`{action, coordinate, display_width_px}`)
 * that no tool has produced since the app-session rewrite. It therefore never
 * rendered: every computer-use call in chat fell through to the generic JSON
 * tool block.
 *
 * The screenshot now arrives as a real MCP image block rather than base64
 * inside `output`, so the card reads `part.mcpContent` and is registered as
 * rich-content aware.
 */

import { useMemo } from "react"
import { MousePointerClickIcon, ScanSearchIcon, ScreenShareIcon, TypeIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import type { ToolUIPart } from "ai"

import { hasMcpContent } from "@/lib/claude/parts-extensions"
import { ImageBlock } from "@/components/chat/renderers/image-block"
import { Badge } from "@/components/ui/badge"
import { McpCardShell, blockMediaSrc, useParsedOutput } from "./common"

/** The JSON half of a `get_app_state` / `zoom` result. */
interface RevisionOutput {
  app?: { displayName?: string }
  revision?: number
  screenshot?: { width?: number; height?: number } | null
  screenshotUnchanged?: boolean
  screenshotNote?: string
  region?: { x: number; y: number; width: number; height: number }
  tree?: { nodes?: unknown[] }
}

/** `perform_action` returns an ActionResult. */
interface ActionOutput {
  status?: "delivered" | "notDelivered" | "refused" | "unknown"
  method?: "ax" | "synthetic"
  beforeRevision?: number
  afterRevision?: number | null
}

interface OcrOutput {
  ok?: boolean
  matches?: { text: string }[]
  clicked?: { text: string }
}

interface ActionInput {
  request?: {
    action?: { kind?: string }
    strategy?: string
    target?: { kind?: string }
  }
  query?: string
  durationMs?: number
}

/** Short tool name regardless of which rail the call arrived on. */
function bareName(part: ToolUIPart): string {
  const raw = (part as unknown as { type?: string }).type ?? ""
  const name = raw.startsWith("tool-") ? raw.slice(5) : raw
  return name.split("__").pop() ?? name
}

export function ComputerUseCard({ part }: { part: ToolUIPart }) {
  const t = useTranslations("chat.mcp.computerUse")
  const tool = bareName(part)
  const input = (part.input ?? {}) as ActionInput
  const parsed = useParsedOutput<RevisionOutput & ActionOutput & OcrOutput>(part.output)

  const images = useMemo(() => {
    if (!hasMcpContent(part)) return []
    return part.mcpContent
      .filter((block) => block.type === "image")
      .map((block) => blockMediaSrc(block, "image/png"))
      .filter((src): src is string => src !== null)
  }, [part])

  // Frame-bearing tools: get_app_state and zoom.
  if (images.length > 0) {
    const width = parsed?.screenshot?.width
    const height = parsed?.screenshot?.height
    const region = parsed?.region
    return (
      <McpCardShell
        title={`${tool}${parsed?.app?.displayName ? ` · ${parsed.app.displayName}` : ""}`}
        badge={
          width && height
            ? `${width}×${height}${parsed?.revision ? ` · r${parsed.revision}` : ""}`
            : undefined
        }
        testId="computer-use-card-frame"
      >
        {region && (
          <Badge variant="secondary" className="mb-1 text-[10px]">
            {t("region", region)}
          </Badge>
        )}
        {images.map((src, index) => (
          <ImageBlock
            key={src.slice(0, 64) + String(index)}
            src={src}
            alt={t("frameAlt", { tool })}
            width={width}
            height={height}
          />
        ))}
      </McpCardShell>
    )
  }

  // A withheld frame is not an error: the screen did not change since the last
  // revision, and saying so is the point.
  if (parsed?.screenshotUnchanged) {
    return (
      <McpCardShell
        title={tool}
        badge={parsed.revision ? `r${parsed.revision}` : undefined}
        testId="computer-use-card-unchanged"
      >
        <p className="text-muted-foreground text-[11px]">
          {parsed.screenshotNote ?? t("screenUnchanged")}
        </p>
      </McpCardShell>
    )
  }

  // perform_action.
  if (parsed?.status) {
    const delivered = parsed.status === "delivered"
    return (
      <McpCardShell
        title={`${tool} · ${input.request?.action?.kind ?? t("actionFallback")}`}
        badge={parsed.status}
        testId="computer-use-card-action"
      >
        <div className="flex flex-wrap items-center gap-2">
          {delivered ? (
            <MousePointerClickIcon className="size-3 text-muted-foreground" />
          ) : (
            <TypeIcon className="text-destructive size-3" />
          )}
          {input.request?.target?.kind && (
            <Badge variant="secondary" className="text-[10px]">
              {input.request.target.kind}
            </Badge>
          )}
          {parsed.method && (
            <Badge variant="secondary" className="text-[10px]">
              {parsed.method}
            </Badge>
          )}
          {typeof parsed.afterRevision === "number" && (
            <Badge variant="secondary" className="text-[10px]">
              r{parsed.beforeRevision} → r{parsed.afterRevision}
            </Badge>
          )}
        </div>
      </McpCardShell>
    )
  }

  // find_text / click_text.
  if (parsed?.matches || parsed?.clicked) {
    const label = parsed.clicked
      ? parsed.clicked.text
      : t("matches", { count: parsed.matches?.length ?? 0 })
    return (
      <McpCardShell title={tool} badge={input.query} testId="computer-use-card-ocr">
        <div className="flex items-center gap-2">
          <ScanSearchIcon className="size-3 text-muted-foreground" />
          <code className="max-w-[40ch] truncate font-mono text-[10px]">{label}</code>
        </div>
      </McpCardShell>
    )
  }

  // Everything else: list_apps / query_elements / expand_element / wait.
  const nodeCount = parsed?.tree?.nodes?.length
  return (
    <McpCardShell
      title={tool}
      badge={typeof nodeCount === "number" ? t("nodes", { count: nodeCount }) : undefined}
      testId="computer-use-card-generic"
    >
      <div className="flex items-center gap-2">
        <ScreenShareIcon className="size-3 text-muted-foreground" />
        {typeof input.durationMs === "number" && (
          <Badge variant="secondary" className="text-[10px]">
            {input.durationMs}ms
          </Badge>
        )}
      </div>
    </McpCardShell>
  )
}

export default ComputerUseCard
