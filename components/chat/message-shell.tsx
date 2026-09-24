"use client"

import { useMemo, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { BotIcon, CircleAlertIcon, SquareIcon, UserIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import type { UsageInfo } from "@/lib/claude/adapter"
import type { ResolvedMessageDisplayOptions } from "@/lib/chat/message-display"
import type { MessageDisplayMetadataOptions } from "@/types/appearance"
import { assistantBubbleClass, messageCardClass } from "@/lib/chat/message-bubble"
import { runMetadataOf, type MessageRunMetadata } from "@/lib/chat/message-run-metadata"
import { RouterFusionRunCard } from "@/components/router-fusion/router-fusion-run-card"
import { RoutingIndicator } from "@/components/chat/routing-indicator"
import { useSettingsStore } from "@/stores/settings"
import { getLucideExport } from "@/lib/icons/lucide-catalog"
import { cn } from "@/lib/utils"
import { AvatarBadge } from "@/components/desktop/avatar-badge"
import { BrandIcon } from "@/components/icons/brand-icon"
import type { AvatarSubject } from "@/lib/ui/avatar"
import type { UIMessage } from "ai"
import { MessageMotionProvider } from "@/components/chat/motion/motion-reveal"
import { ToolStatusDot, type ToolDotStatus } from "@/components/chat/message-parts/tool-row"

export interface MessageShellProps {
  message: UIMessage
  display: ResolvedMessageDisplayOptions
  speakerName?: string
  speakerColor?: string
  /**
   * The speaker's avatar subject (a character, or a bare name for a person we
   * only know by display name). Renders the real portrait / emoji / initials
   * instead of the generic bot glyph.
   */
  speakerAvatar?: AvatarSubject
  isStreaming?: boolean
  /**
   * Stop this speaker alone (ADR-0177 batch 3). Set only while a room
   * member is mid-reply, so the header offers the per-member interrupt
   * exactly when there is one to make, and the rest of the room goes on.
   */
  onStopSpeaker?: () => void
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

export interface MetadataDetailRow {
  key: MetadataField
  label: string
  value: string
}

function formatTimestamp(value: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(value)
}

/** The icon a sealed run's `agent.icon` resolves to, or an emoji/text glyph. */
function agentIconNode(icon: string | undefined, className: string, color?: string): ReactNode {
  if (!icon) return null
  const LucideIcon = getLucideExport(icon) ?? getLucideExport(toPascal(icon))
  if (LucideIcon) {
    return <LucideIcon className={className} style={color ? { color } : undefined} />
  }
  // A preset may carry a single emoji glyph instead of a Lucide export name.
  if (/\p{Extended_Pictographic}/u.test(icon)) {
    return (
      <span className="text-[11px] leading-none" aria-hidden>
        {icon}
      </span>
    )
  }
  return null
}

function toPascal(name: string): string {
  return name
    .split(/[-_\s]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")
}

/**
 * The run-metadata snapshot both the header and the footer meta line read.
 * Extracted because the meta line lives in `message-renderer`'s action row
 * while the values live here — deriving them twice would let the two
 * placements drift on the same message.
 */
function useMessageMetadata(
  message: UIMessage,
  display: ResolvedMessageDisplayOptions,
  speakerName: string | undefined
): {
  run: MessageRunMetadata | undefined
  usage: UsageInfo | undefined
  createdAt: number | undefined
  isAssistant: boolean
  identity: string
  metadataValues: Partial<Record<MetadataField, string>>
  detailRows: MetadataDetailRow[]
} {
  const t = useTranslations("chat.messageDisplay")
  const metadata = (message.metadata as Record<string, unknown> | undefined) ?? {}
  const run = runMetadataOf(message)
  const usage = metadata.usage as UsageInfo | undefined
  const createdAt = typeof metadata.createdAt === "number" ? metadata.createdAt : undefined
  const isAssistant = message.role === "assistant"
  // The sealed preset/agent name beats the generic "Assistant"; the runtime or
  // Squad member an addressed turn went to beats that (it is who actually
  // answered); a room speaker beats all of them — a named speaker is the only
  // thing that says which participant is talking.
  const identity =
    speakerName ??
    (isAssistant ? run?.route?.label : undefined) ??
    run?.agent?.name ??
    (isAssistant ? t("assistant") : t("you"))
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
  const detailRows = useMemo<MetadataDetailRow[]>(
    () =>
      METADATA_FIELDS.filter(
        (key) => display.metadata[key] === "details" && Boolean(metadataValues[key])
      ).map((key) => ({
        key,
        label: t(`metadata.${key}`),
        value: metadataValues[key] as string,
      })),
    [display.metadata, metadataValues, t]
  )

  return { run, usage, createdAt, isAssistant, identity, metadataValues, detailRows }
}

/**
 * The compact run-metadata chip that lives on the right end of the action
 * footer (`message-renderer`). The summary — `external · 5.5s · ↑2.8k ↓15 ·
 * $0.0216` — is itself the answer for most checks; clicking opens a popover
 * with the full per-field list, anchored to the chip so expansion never moves
 * the transcript around it.
 */
export function MessageMetaLine({
  message,
  display,
  speakerName,
  className,
}: {
  message: UIMessage
  display: ResolvedMessageDisplayOptions
  speakerName?: string
  className?: string
}) {
  const t = useTranslations("chat.messageDisplay")
  const { detailRows } = useMessageMetadata(message, display, speakerName)
  if (detailRows.length === 0) return null
  const summary = detailRows.map((row) => row.value).join(" · ")
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("details")}
          title={t("details")}
          data-testid="message-meta-line"
          className={cn(
            "inline-flex h-6 min-w-0 items-center rounded-md px-1.5",
            "text-[11px] text-muted-foreground transition-colors",
            "hover:bg-muted/60 hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            className
          )}
        >
          <span className="truncate font-mono tabular-nums">{summary}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-auto max-w-sm p-3"
        data-testid="message-meta-popover"
      >
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {detailRows.map((row) => (
            <div key={row.key} className="contents">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0 break-words font-mono text-foreground">{row.value}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  )
}

export function MessageShell({
  message,
  display,
  speakerName,
  speakerColor,
  speakerAvatar,
  isStreaming = false,
  onStopSpeaker,
  children,
}: MessageShellProps) {
  const t = useTranslations("chat.messageDisplay")
  const { run, createdAt, isAssistant, identity, metadataValues } = useMessageMetadata(
    message,
    display,
    speakerName
  )
  const isError = Boolean(run?.finishReason && /error|fail|abort|cancel/i.test(run.finishReason))
  /**
   * A named speaker means this message came out of a ROOM: a character team, a
   * shared session, or an IM group. There the header is not decoration, it is
   * the only thing that says which of several participants is talking, so it
   * overrides the metadata placement preference. A direct chat has no
   * `speakerName` and keeps honouring the setting exactly as before.
   */
  const inRoom = Boolean(speakerName)
  /**
   * An addressed turn (`@codex`, `@claude`, a Squad member) was answered by
   * someone other than the conversation's own runtime. Like a room speaker,
   * that is only visible if the header says so, so it shows regardless of the
   * placement preference.
   */
  const route = isAssistant ? run?.route : undefined
  const showIdentity = inRoom || Boolean(route) || display.metadata.identity === "header"
  // Auto-routing explainability chip (ADR-0043 Phase 12). Opt-out: the flag
  // defaults to on and only an explicit `false` hides it.
  const showRoutingIndicator =
    useSettingsStore((s) => s.settings?.autoRouting?.showRoutingIndicator) !== false
  const routingChip =
    isAssistant &&
    run?.routing !== undefined &&
    run.routing.mode !== "manual" &&
    showRoutingIndicator

  // The same breathing-dot language every tool row leads with, lifted to the
  // turn's own row: a message IS the largest activity in the stream. Complete
  // is the default state, so it gets a quiet green dot and no "Complete" text —
  // the status chip below only speaks when something is actually happening
  // (streaming) or went wrong (error).
  const statusDot: ToolDotStatus | null = isAssistant
    ? isStreaming
      ? "running"
      : isError
        ? "error"
        : "complete"
    : null

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
        {(showIdentity ||
          display.metadata.timestamp === "header" ||
          headerItems.length > 0 ||
          routingChip ||
          statusDot) && (
          <header
            className={cn(
              "mb-1.5 flex min-h-6 flex-wrap items-center gap-1.5 text-xs text-muted-foreground",
              !isAssistant && "justify-end"
            )}
            data-testid="message-shell-header"
          >
            {statusDot ? (
              <span data-testid="message-status-dot" className="inline-flex items-center">
                <ToolStatusDot status={statusDot} />
              </span>
            ) : null}
            {showIdentity && (
              <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                {speakerAvatar ? (
                  <AvatarBadge subject={speakerAvatar} size={14} textClassName="text-[8px]" />
                ) : route?.brandId ? (
                  <BrandIcon id={route.brandId} label={identity} size={14} />
                ) : isAssistant ? (
                  (agentIconNode(run?.agent?.icon, "size-3.5", speakerColor) ?? (
                    <BotIcon
                      className="size-3.5"
                      style={speakerColor ? { color: speakerColor } : undefined}
                    />
                  ))
                ) : (
                  <UserIcon className="size-3.5" />
                )}
                <span style={speakerColor ? { color: speakerColor } : undefined}>{identity}</span>
                {route ? (
                  <span
                    className="font-normal text-muted-foreground"
                    data-testid="message-route-via"
                    data-route-runtime={route.runtimeKind}
                  >
                    {t("routedVia", { handle: route.handle })}
                  </span>
                ) : null}
              </span>
            )}
            {onStopSpeaker ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onStopSpeaker}
                aria-label={t("stopSpeaker", { name: identity })}
                title={t("stopSpeaker", { name: identity })}
                className="size-5 text-muted-foreground hover:text-destructive"
                data-testid="message-stop-speaker"
              >
                <SquareIcon className="size-3 fill-current" />
              </Button>
            ) : null}
            {headerItems.map((item) => (
              <Badge key={item} variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
                {item}
              </Badge>
            ))}
            {routingChip && run?.routing ? <RoutingIndicator routing={run.routing} /> : null}
            {display.metadata.timestamp === "header" && createdAt !== undefined && (
              <time dateTime={new Date(createdAt).toISOString()} className="tabular-nums">
                {formatTimestamp(createdAt)}
              </time>
            )}
            {isAssistant && (isStreaming || isError) && (
              <span className="inline-flex items-center gap-1" role="status" aria-live="polite">
                {isStreaming ? (
                  <Spinner className="size-3" />
                ) : (
                  <CircleAlertIcon className="size-3 text-destructive" aria-hidden />
                )}
                {isStreaming ? t("status.streaming") : t("status.error")}
              </span>
            )}
          </header>
        )}

        <div data-testid="message-shell-body">{children}</div>

        {/* Router + Fusion run card (ADR-0188): only a turn that went through it
            carries `run.routerFusion`, so every other message renders as before. */}
        {isAssistant && run?.routerFusion ? (
          <div className="mt-1.5 flex">
            <RouterFusionRunCard routerFusion={run.routerFusion} />
          </div>
        ) : null}
      </section>
    </MessageMotionProvider>
  )
}
