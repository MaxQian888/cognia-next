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
  const detailRows = useMemo(() => {
    const rows: Array<{ key: string; label: string; value: ReactNode }> = []
    const add = (
      placement: "hidden" | "header" | "details",
      key: string,
      value: ReactNode | undefined
    ) => {
      if (placement === "details" && value !== undefined) {
        rows.push({ key, label: t(`metadata.${key}`), value })
      }
    }
    add(display.metadata.identity, "identity", identity)
    add(
      display.metadata.timestamp,
      "timestamp",
      createdAt === undefined ? undefined : formatTimestamp(createdAt)
    )
    add(display.metadata.model, "model", run?.modelId)
    add(display.metadata.provider, "provider", run?.providerId)
    add(
      display.metadata.duration,
      "duration",
      run?.durationMs === undefined ? undefined : t("durationValue", { value: run.durationMs })
    )
    add(
      display.metadata.usage,
      "usage",
      usage
        ? t("usageValue", {
            input: usage.inputTokens ?? 0,
            output: usage.outputTokens ?? 0,
          })
        : undefined
    )
    add(
      display.metadata.cost,
      "cost",
      usage?.totalCostUsd === undefined ? undefined : `$${usage.totalCostUsd.toFixed(4)}`
    )
    add(display.metadata.finishState, "finishState", run?.finishReason)
    return rows
  }, [createdAt, display.metadata, identity, run, t, usage])

  const headerItems = [
    display.metadata.model === "header" && run?.modelId ? run.modelId : undefined,
    display.metadata.provider === "header" && run?.providerId ? run.providerId : undefined,
    display.metadata.duration === "header" && run?.durationMs !== undefined
      ? t("durationValue", { value: run.durationMs })
      : undefined,
    display.metadata.finishState === "header" && run?.finishReason ? run.finishReason : undefined,
  ].filter((value): value is string => Boolean(value))

  return (
    <MessageMotionProvider motion={display.motion}>
      <section
        data-testid="message-shell"
        data-layout={display.layout}
        data-preset={display.preset}
        data-rich-controls={display.richControls}
        className={cn(
          "min-w-0",
          (isAssistant || display.layout === "cards") && "w-full",
          display.layout === "cards" && "rounded-xl border bg-card p-3 shadow-sm",
          display.layout === "bubbles" && isAssistant && "rounded-2xl bg-muted/45 px-4 py-3"
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
