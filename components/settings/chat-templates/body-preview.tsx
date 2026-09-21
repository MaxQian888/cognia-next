"use client"

// The template body rendered the way the composer sees it: `{{tokens}}` as
// chips, everything else as text.
//
// This is the piece the old settings page never had — the parameter tokens
// were listed as detached badges under a collapsed `<pre>`, so a template
// read as prose with footnotes instead of a sentence with slots. Chips are
// inline BECAUSE the parameter's position in the sentence is the parameter:
// "review {{module}} on {{branch}}" and "on {{branch}}, review {{module}}"
// are different templates.
//
// Clickable chips reuse the composer's fill gesture: the popover that opens
// is the same `TemplateParamPopover` a send would open, so rehearsing here
// teaches the real interaction.

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { ChatTemplateParamValue } from "@/lib/chat/template/binding"
import { paramState, paramValueText } from "@/lib/chat/template/binding"
import { listParamTokens } from "@/lib/chat/template/param-segments"
import { computeCodeRanges } from "@/lib/chat/template/code-ranges"

interface BodyPiece {
  kind: "text" | "param"
  text: string
  paramId?: string
}

/** Split a body into text runs and `{{param}}` tokens, excluding code ranges. */
function splitBody(body: string): BodyPiece[] {
  const tokens = listParamTokens(body, computeCodeRanges(body))
  const pieces: BodyPiece[] = []
  let cursor = 0
  for (const token of tokens) {
    if (token.start > cursor) pieces.push({ kind: "text", text: body.slice(cursor, token.start) })
    pieces.push({ kind: "param", text: token.raw, paramId: token.paramId })
    cursor = token.end
  }
  if (cursor < body.length) pieces.push({ kind: "text", text: body.slice(cursor) })
  return pieces
}

export function ChatTemplateBodyPreview({
  body,
  values,
  className,
  onParamClick,
  isResolvable,
}: {
  body: string
  /** Current per-param values — filled chips show the substituted text. */
  values?: Record<string, ChatTemplateParamValue>
  className?: string
  /** Makes chips buttons; the popover itself anchors to the parent preview box. */
  onParamClick?: (paramId: string) => void
  /** Resource-value resolvable check — feeds the "unresolved" chip state. */
  isResolvable?: (value: Extract<ChatTemplateParamValue, { kind: "resource" }>) => boolean
}) {
  const pieces = useMemo(() => splitBody(body), [body])
  return (
    <div
      className={cn(
        "whitespace-pre-wrap rounded-md border bg-muted/30 p-3 font-mono text-xs leading-6",
        className
      )}
      data-testid="chat-template-body-preview"
    >
      {pieces.map((piece, index) =>
        piece.kind === "text" ? (
          <span key={index}>{piece.text}</span>
        ) : (
          <ParamChip
            key={index}
            id={piece.paramId ?? ""}
            value={values?.[piece.paramId ?? ""]}
            onClick={onParamClick}
            isResolvable={isResolvable}
          />
        )
      )}
    </div>
  )
}

function ParamChip({
  id,
  value,
  onClick,
  isResolvable,
}: {
  id: string
  value?: ChatTemplateParamValue
  onClick?: (paramId: string) => void
  isResolvable?: (value: Extract<ChatTemplateParamValue, { kind: "resource" }>) => boolean
}) {
  const t = useTranslations("chatTemplatesSettings")
  const state = paramState(value, isResolvable)
  const chip = (
    <Badge
      variant="secondary"
      className={cn(
        "mx-0.5 inline-flex translate-y-[-1px] items-center rounded px-1.5 py-0 font-mono text-[11px]",
        // Same pill language the composer overlay paints (`PARAM_PILL_CLASS`):
        // empty is a neutral dashed outline, filled wears the primary tint,
        // unresolved is amber — not red, the value is kept, not lost.
        state === "empty" &&
          "border border-dashed border-muted-foreground/50 bg-transparent text-muted-foreground",
        state === "filled" && "bg-primary/10 text-primary ring-1 ring-inset ring-primary/25",
        state === "unresolved" &&
          "bg-amber-500/10 text-amber-700 ring-1 ring-inset ring-amber-500/40 dark:text-amber-300",
        onClick && "cursor-pointer transition-colors hover:brightness-110"
      )}
    >
      {state === "empty" ? `{{${id}}}` : paramValueText(value)}
    </Badge>
  )
  if (!onClick) return chip
  return (
    <button type="button" aria-label={t("fillSlot", { id })} onClick={() => onClick(id)}>
      {chip}
    </button>
  )
}
