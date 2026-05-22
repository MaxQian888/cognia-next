"use client"

/**
 * ADR-0020 W3 — inline renderer for the `computer_use` Plugin MCP tool.
 *
 * Pre-W3 the model returned a base64-encoded PNG from a `screenshot`
 * action as a generic tool_result; the chat only showed a collapsible
 * "tool output" block with the raw text. Operators couldn't see what
 * the model was seeing without scraping the encoded bytes from the
 * tool block.
 *
 * W3 renders the screenshot inline via the existing
 * `<ImageBlock>` (zoom / download / copy / fullscreen all reused).
 * Non-screenshot actions (click / type / scroll / …) fall through to a
 * compact action chip + status badge so the chat history stays
 * scannable. Errors render with a destructive Badge so the operator
 * can spot consent-decline / backend failures at a glance.
 */

import { MousePointerClickIcon, ScreenShareIcon } from "lucide-react"
import type { ToolUIPart } from "ai"
import { McpCardShell, useParsedOutput } from "./common"
import { Badge } from "@/components/ui/badge"
import { ImageBlock } from "@/components/chat/renderers/image-block"

interface ComputerUseInput {
  action?: string
  coordinate?: [number, number]
  start_coordinate?: [number, number]
  text?: string
  scroll_direction?: "up" | "down" | "left" | "right"
  scroll_amount?: number
  duration?: number
}

interface ComputerUseOutput {
  ok?: boolean
  output?: string
  error?: string
  display_width_px?: number
  display_height_px?: number
  cursor?: { x: number; y: number }
}

export function ComputerUseCard({ part }: { part: ToolUIPart }) {
  const input = (part.input ?? {}) as ComputerUseInput
  const parsed = useParsedOutput<ComputerUseOutput>(part.output)
  const action = input.action ?? "unknown"

  // Screenshot path — render the inline image. `output` is a base64
  // PNG when `ok && display_width_px` are present.
  if (parsed?.ok && parsed?.output && parsed.display_width_px && parsed.display_height_px) {
    const src = `data:image/png;base64,${parsed.output}`
    return (
      <McpCardShell
        title={`computer_use · ${action}`}
        badge={`${parsed.display_width_px}×${parsed.display_height_px}`}
        testId="computer-use-card-screenshot"
      >
        <ImageBlock
          src={src}
          alt={`Computer Use ${action}`}
          width={parsed.display_width_px}
          height={parsed.display_height_px}
        />
      </McpCardShell>
    )
  }

  // Cursor-position path — render the coordinate plainly.
  if (parsed?.ok && parsed?.cursor) {
    return (
      <McpCardShell title={`computer_use · ${action}`} badge="ok" testId="computer-use-card-cursor">
        <code className="font-mono text-[11px]">
          ({parsed.cursor.x}, {parsed.cursor.y})
        </code>
      </McpCardShell>
    )
  }

  // Error path — surface the message so the operator can spot
  // consent-decline or backend failures without expanding the raw tool
  // block.
  if (parsed && parsed.ok === false) {
    return (
      <McpCardShell
        title={`computer_use · ${action}`}
        badge="error"
        testId="computer-use-card-error"
      >
        <p className="text-destructive text-[11px]">{parsed.error ?? "unknown error"}</p>
      </McpCardShell>
    )
  }

  // Non-screenshot driving actions (click / type / scroll / …) —
  // compact chip showing the action + relevant fields.
  return (
    <McpCardShell
      title={`computer_use · ${action}`}
      badge={parsed?.ok === true ? "ok" : undefined}
      testId="computer-use-card-action"
    >
      <div className="flex flex-wrap items-center gap-2">
        {action === "screenshot" ? (
          <ScreenShareIcon className="size-3 text-muted-foreground" />
        ) : (
          <MousePointerClickIcon className="size-3 text-muted-foreground" />
        )}
        {input.coordinate && (
          <Badge variant="secondary" className="text-[10px]">
            ({input.coordinate[0]}, {input.coordinate[1]})
          </Badge>
        )}
        {input.start_coordinate && (
          <Badge variant="secondary" className="text-[10px]">
            from ({input.start_coordinate[0]}, {input.start_coordinate[1]})
          </Badge>
        )}
        {input.scroll_direction && (
          <Badge variant="secondary" className="text-[10px]">
            {input.scroll_direction} × {input.scroll_amount ?? 1}
          </Badge>
        )}
        {input.text && (
          <code className="font-mono text-[10px] max-w-[40ch] truncate">{input.text}</code>
        )}
      </div>
    </McpCardShell>
  )
}

export default ComputerUseCard
