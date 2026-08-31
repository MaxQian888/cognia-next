"use client"

import { useMemo, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleAlertIcon,
  Loader2Icon,
  UserIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import type { UsageInfo } from "@/lib/claude/adapter"
import type { ResolvedMessageDisplayOptions } from "@/lib/chat/message-display"
import type { MessageDisplayMetadataOptions } from "@/types/appearance"
import { assistantBubbleClass, messageCardClass } from "@/lib/chat/message-bubble"
import { runMetadataOf } from "@/lib/chat/message-run-metadata"
import { cn } from "@/lib/utils"
import type { UIMessage } from "ai"
import { MessageMotionProvider } from "@/components/chat/motion/motion-reveal"

export interface MessageShellProps {
  message: UIMessage
  display: ResolvedMessageDisplayOptions
  speakerName?: string
  speakerColor?: string
  isStreaming?: boolean
  children: ReactNode
}

/**
 * Every metadata field the display settings expose, in the order they read in
 * the header and the details list. Exported so a test can assert the catalogue
 * matches `MessageDisplayMetadataOptions` — a field missing here would be
 * silently unrenderable in both placements.
 */
export const METADATA_FIELDS = [
  "identity",
  "timestamp",
  "model",
  "provider",
  "duration",
  "usage",
  "cost",
  "finishState",
] as const satisfies ReadonlyArray<keyof MessageDisplayMetadataOptions>

type MetadataField = (typeof METADATA_FIELDS)[number]

function formatTimestamp(value: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(value)
}

export function MessageShell({
  message,
  display,
  speakerName,
  speakerColor,
  isStreaming = false,
  children,
}: MessageShellProps) {
  const t = useTranslations("chat.messageDisplay")
  const [detailsOpen, setDetailsOpen] = useState(false)
  const metadata = (message.metadata as Record<string, unknown> | undefined) ?? {}
  const run = runMetadataOf(message)
  const usage = metadata.usage as UsageInfo | undefined
  const createdAt = typeof metadata.createdAt === "number" ? metadata.createdAt : undefined
  const isAssistant = message.role === "assistant"
  const isError = Boolean(run?.finishReason && /error|fail|abort|cancel/i.test(run.finishReason))
  const identity = speakerName ?? (isAssistant ? t("assistant") : t("you"))
  // One formatted value per metadata field, read by BOTH placements. `header`
  // and `details` used to be assembled independently, and the header list
  // simply omitted `usage` and `cost` — so choosing "header" for either
  // rendered nothing at all, even though the settings offer the same three
  // placements for every field. Deriving both from this map is what makes that
  // class of gap impossible rather than merely fixed.
  const metadataValues = useMemo<Partial<Record<MetadataField, string>>>(
    () => ({
      identity,
      timestamp: createdAt === undefined ? undefined : formatTimestamp(createdAt),
      model: run?.modelId,
      provider: run?.providerId,
      duration:
        run?.durationMs === undefined ? undefined : t("durationValue", { value: run.durationMs }),
      usage: usage
        ? t("usageValue", { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 })
        : undefined,
      cost: usage?.totalCostUsd === undefined ? undefined : `$${usage.totalCostUsd.toFixed(4)}`,
      finishState: run?.finishReason,
    }),
    [createdAt, identity, run, t, usage]
  )

  // A field with nothing to say is ABSENT, not an empty chip. `modelId`,
  // `providerId` and `finishReason` are persisted strings and an unresolved run
  // stores them as `""`, which a bare `!== undefined` check would render as a
  // blank header entry (with its separator) or a blank details row.
  const detailRows = useMemo(
    () =>
      METADATA_FIELDS.filter(
        (key) => display.metadata[key] === "details" && Boolean(metadataValues[key])
      ).map((key) => ({
        key,
        label: t(`metadata.${key}`),
        value: metadataValues[key] as ReactNode,
      })),
    [display.metadata, metadataValues, t]
  )

  // `identity` and `timestamp` render their own header elements below (icon +
  // colour, and a `<time>`), so they are excluded here rather than missing.
  const headerItems = METADATA_FIELDS.filter(
    (key) =>
      key !== "identity" &&
      key !== "timestamp" &&
      display.metadata[key] === "header" &&
      Boolean(metadataValues[key])
  ).map((key) => metadataValues[key] as string)

  return (
    <MessageMotionProvider motion={display.motion}>
      <section
        data-testid="message-shell"
        data-layout={display.layout}
        data-preset={display.preset}
        data-rich-controls={display.richControls}
        data-body-font={display.bodyFont}
        className={cn(
          "min-w-0",
          (isAssistant || display.layout === "cards") && "w-full",
          // Same module as the user bubble (ADR-0148). The two sides sit on
          // different elements — the user's hugs its content, the assistant's
          // is this shell — so the strings, not the DOM, are what is shared.
          messageCardClass(display.layout),
          isAssistant && assistantBubbleClass(display.layout)
        )}
      >
        {(display.metadata.identity === "header" ||
          display.metadata.timestamp === "header" ||
          headerItems.length > 0) && (
          <header
            className={cn(
              "mb-1.5 flex min-h-6 flex-wrap items-center gap-1.5 text-xs text-muted-foreground",
              !isAssistant && "justify-end"
            )}
            data-testid="message-shell-header"
          >
            {display.metadata.identity === "header" && (
              <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                {isAssistant ? (
                  <BotIcon
                    className="size-3.5"
                    style={speakerColor ? { color: speakerColor } : undefined}
                  />
                ) : (
                  <UserIcon className="size-3.5" />
                )}
                <span style={speakerColor ? { color: speakerColor } : undefined}>{identity}</span>
              </span>
            )}
            {headerItems.map((item) => (
              <Badge key={item} variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
                {item}
              </Badge>
            ))}
            {display.metadata.timestamp === "header" && createdAt !== undefined && (
              <time dateTime={new Date(createdAt).toISOString()} className="tabular-nums">
                {formatTimestamp(createdAt)}
              </time>
            )}
            {isAssistant && (
              <span className="inline-flex items-center gap-1" role="status" aria-live="polite">
                {isStreaming ? (
                  <Loader2Icon className="size-3 animate-spin" aria-hidden />
                ) : isError ? (
                  <CircleAlertIcon className="size-3 text-destructive" aria-hidden />
                ) : (
                  <CheckCircle2Icon className="size-3" aria-hidden />
                )}
                {isStreaming
                  ? t("status.streaming")
                  : isError
                    ? t("status.error")
                    : t("status.complete")}
              </span>
            )}
          </header>
        )}

        <div data-testid="message-shell-body">{children}</div>

        {detailRows.length > 0 && (
          <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen} className="mt-2">
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                aria-label={t("details")}
              >
                <ChevronDownIcon
                  className={cn("size-3.5 transition-transform", detailsOpen && "rotate-180")}
                />
                {t("details")}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 px-2 py-1 text-xs">
                {detailRows.map((row) => (
                  <div key={row.key} className="contents">
                    <dt className="text-muted-foreground">{row.label}</dt>
                    <dd className="min-w-0 break-words font-mono text-foreground">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </CollapsibleContent>
          </Collapsible>
        )}
      </section>
    </MessageMotionProvider>
  )
}
