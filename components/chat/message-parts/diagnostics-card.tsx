"use client"

/**
 * DiagnosticsCard — renders the structured output of the `/context`, `/usage`
 * and `/cost` slash commands as a compact card (progress bars, badges, token
 * breakdown) instead of a flat markdown bullet list. Fed by a
 * `data-diagnostics` UI message part carrying a {@link SystemMessageBlock}
 * (see `lib/slash-commands/system-blocks.ts`).
 *
 * The context-window bar reuses `ContextWindowHeader` from the composer
 * indicator so the visual language (green → amber → red fill + auto-compact
 * marker) matches the live read-out under the composer.
 *
 * `/usage` outgrew a shared file — it fuses plan quota with local spend
 * attribution and carries its own scope/axis state — so it lives in
 * `usage-diagnostics-card.tsx` and is dispatched to from here.
 */

import { useTranslations } from "next-intl"
import { CoinsIcon, MessagesSquareIcon } from "lucide-react"
import { Surface } from "@/components/surface/surface"
import { ContextWindowHeader, UsageRow } from "@/components/chat/context-usage-indicator"
import {
  DIAGNOSTICS_TINT,
  UsageDiagnosticsCard,
} from "@/components/chat/message-parts/usage-diagnostics-card"
import type {
  ContextDiagnosticsBlock,
  CostDiagnosticsBlock,
  SystemMessageBlock,
} from "@/lib/slash-commands/system-blocks"

const compact = new Intl.NumberFormat("en-US", { notation: "compact" })
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
})

export function DiagnosticsCard({ block }: { block: SystemMessageBlock }) {
  if (block.kind === "context") return <ContextCard block={block} />
  if (block.kind === "cost") return <CostCard block={block} />
  return <UsageDiagnosticsCard block={block} />
}

function CardShell({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <Surface
      layer="raised"
      radius="stage"
      data-testid="diagnostics-card"
      style={DIAGNOSTICS_TINT}
      className="not-prose my-1 w-full max-w-md space-y-3 border p-3"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
          {icon}
        </span>
        {title}
      </div>
      {children}
    </Surface>
  )
}

function ContextCard({ block }: { block: ContextDiagnosticsBlock }) {
  const t = useTranslations("chat.diagnostics")
  return (
    <CardShell icon={<MessagesSquareIcon className="size-3.5" />} title={t("contextTitle")}>
      <UsageRow
        label={t("messages")}
        slot={t("messagesValue", { user: block.userTurns, assistant: block.assistantTurns })}
      />
      {block.window ? (
        <ContextWindowHeader
          fraction={block.window.fraction}
          level={block.window.level}
          used={block.window.used}
          max={block.window.max}
        />
      ) : (
        <p className="text-xs text-muted-foreground">{t("freshWindow")}</p>
      )}
      {block.tokens ? (
        <div className="space-y-1.5 border-t pt-2">
          <UsageRow
            label={t("inputTokens")}
            slot={compact.format(
              block.tokens.input + block.tokens.cacheRead + block.tokens.cacheCreate
            )}
          />
          <UsageRow label={t("outputTokens")} slot={compact.format(block.tokens.output)} />
          {block.tokens.cacheRead > 0 || block.tokens.cacheCreate > 0 ? (
            <UsageRow
              label={t("cache")}
              slot={t("cacheValue", {
                write: compact.format(block.tokens.cacheCreate),
                read: compact.format(block.tokens.cacheRead),
              })}
            />
          ) : null}
        </div>
      ) : null}
      {block.window ? (
        <p className="text-[11px] text-muted-foreground">{t("compactHint")}</p>
      ) : null}
    </CardShell>
  )
}

function CostCard({ block }: { block: CostDiagnosticsBlock }) {
  const t = useTranslations("chat.diagnostics")
  return (
    <CardShell icon={<CoinsIcon className="size-3.5" />} title={t("costTitle")}>
      <div className="space-y-1.5">
        <UsageRow
          label={t("turns")}
          slot={t("turnsValue", { assistant: block.assistantTurns, metrics: block.metricTurns })}
        />
        <UsageRow label={t("inputTokens")} slot={compact.format(block.inputTokens)} />
        <UsageRow label={t("outputTokens")} slot={compact.format(block.outputTokens)} />
        {block.cacheCreateTokens > 0 || block.cacheReadTokens > 0 ? (
          <UsageRow
            label={t("cache")}
            slot={t("cacheValue", {
              write: compact.format(block.cacheCreateTokens),
              read: compact.format(block.cacheReadTokens),
            })}
          />
        ) : null}
        {block.costUsd != null && block.costUsd > 0 ? (
          <UsageRow
            label={t("cost")}
            slot={
              <span>
                {usd.format(block.costUsd)}
                {block.costEstimated ? (
                  <span className="ml-1 text-muted-foreground">({t("estimated")})</span>
                ) : null}
              </span>
            }
          />
        ) : null}
        {block.durationMs > 0 ? (
          <UsageRow
            label={t("duration")}
            slot={t("durationValue", { seconds: (block.durationMs / 1000).toFixed(1) })}
          />
        ) : null}
      </div>
      {block.window ? (
        <div className="border-t pt-2">
          <ContextWindowHeader
            fraction={block.window.fraction}
            level={block.window.level}
            used={block.window.used}
            max={block.window.max}
          />
        </div>
      ) : null}
    </CardShell>
  )
}
