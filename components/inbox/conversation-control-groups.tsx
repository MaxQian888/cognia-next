"use client"

/**
 * The per-conversation controls, grouped once and drawn in two layouts.
 *
 * Two surfaces show the same controls: the chat header's `⋯` popover
 * (`conversation-header-overflow.tsx`) and the Inbox triage preview
 * (`triage/`). Each used to be a hand-maintained list of the same fifteen
 * chips, which is how one of them grows a control the other never hears
 * about. The groups below are the single source; a host picks the layout:
 *
 *  - `inline` — the chips alone, for a flex-wrapped popover group whose
 *    heading already says what they are.
 *  - `list` — one labelled row per control, for a definition list
 *    (`<ControlList>`). Chips that render nothing (no SLA running, no
 *    pending approvals, a healthy adapter) take their label with them:
 *    `has-[>dd:empty]:hidden` drops the row instead of leaving "SLA:" over a
 *    blank.
 *
 * The chips keep their own queries and writes; this module only arranges them.
 */

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { effectiveStatus } from "@/lib/db/conversation-overrides"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import type { TriggerPolicy } from "@/types/connectors/policy"
import { LifecycleStatusChip } from "./lifecycle-status-chip"
import { AssigneeChip } from "./assignee-chip"
import { SlaBadge } from "./sla-badge"
import { PendingApprovalChip } from "./pending-approval-chip"
import { LabelPicker } from "./label-picker"
import { LastInboundChip } from "./last-inbound-chip"
import { ActiveDelegationsChip } from "./active-delegations-chip"
import { ProviderModelSwitcher } from "./provider-model-switcher"
import { QuietHoursChip } from "./quiet-hours-chip"
import { AtStrategyChip } from "./at-strategy-chip"
import { TopicRuntimeChip } from "./topic-runtime-chip"
import { PolicyInfo } from "./policy-info"
import { AdapterHealthBadge } from "./adapter-health-badge"
import { OutboundStatusPill } from "./outbound-status-pill"
import { ComputerUseToggle } from "./overrides/computer-use-toggle"
import { ComputerUseChip } from "./computer-use-chip"

export type ControlGroupLayout = "inline" | "list"

/** A definition list for `list`-layout groups. Label column sized to its widest label. */
export function ControlList({
  children,
  className,
  ...rest
}: {
  children: ReactNode
  className?: string
  "aria-label"?: string
  "data-testid"?: string
}) {
  return (
    <dl
      className={cn(
        "grid grid-cols-[minmax(5.5rem,max-content)_minmax(0,1fr)] gap-x-3 text-sm",
        className
      )}
      {...rest}
    >
      {children}
    </dl>
  )
}

/** One control. `list`: a labelled row that hides itself when the control renders nothing. */
export function ControlItem({
  label,
  layout,
  children,
  testId,
}: {
  label: string
  layout: ControlGroupLayout
  children: ReactNode
  testId?: string
}) {
  if (layout === "inline") return <>{children}</>
  return (
    <div
      className="col-span-2 grid min-h-9 grid-cols-subgrid items-center py-1 has-[>dd:empty]:hidden"
      data-testid={testId}
    >
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5">{children}</dd>
    </div>
  )
}

interface ConversationScope {
  conversationKey: string
  sessionId: string
  /** Parsed from the conversationKey; "" when unparseable. */
  adapterId: string
  layout: ControlGroupLayout
}

/** Lifecycle, ownership and response obligations. */
export function ConversationStatusControls({
  conversationKey,
  sessionId,
  adapterId,
  overrideRow,
  layout,
}: ConversationScope & { overrideRow?: ConversationOverrideRow }) {
  const t = useTranslations("inbox.controls")
  const status = effectiveStatus(overrideRow)
  return (
    <>
      <ControlItem label={t("status")} layout={layout} testId="control-status">
        <LifecycleStatusChip
          conversationKey={conversationKey}
          sessionId={sessionId}
          status={status}
        />
      </ControlItem>
      <ControlItem label={t("assignee")} layout={layout} testId="control-assignee">
        <AssigneeChip
          conversationKey={conversationKey}
          sessionId={sessionId}
          adapterId={adapterId || undefined}
          assignee={overrideRow?.assignee}
        />
      </ControlItem>
      <ControlItem label={t("labels")} layout={layout} testId="control-labels">
        <LabelPicker
          conversationKey={conversationKey}
          sessionId={sessionId}
          selectedIds={overrideRow?.labelIds ?? []}
        />
      </ControlItem>
      <ControlItem label={t("sla")} layout={layout} testId="control-sla">
        <SlaBadge
          nextResponseDueAt={overrideRow?.nextResponseDueAt}
          status={status}
          escalatedStep={overrideRow?.escalatedStep}
        />
      </ControlItem>
      <ControlItem label={t("approvals")} layout={layout} testId="control-approvals">
        <PendingApprovalChip sessionId={sessionId} />
      </ControlItem>
      <ControlItem label={t("lastInbound")} layout={layout} testId="control-last-inbound">
        <LastInboundChip conversationKey={conversationKey} />
      </ControlItem>
      {/* Renders only while a delegated run is in flight, which is the one
          piece of this conversation's state that lives outside the thread. */}
      <ControlItem label={t("delegations")} layout={layout} testId="control-delegations">
        <ActiveDelegationsChip conversationKey={conversationKey} />
      </ControlItem>
    </>
  )
}

/** Which model answers, when, and under what trigger policy. */
export function ConversationRoutingControls({
  conversationKey,
  sessionId,
  adapterId,
  layout,
  policy,
  providerOverride,
  modelOverride,
  desktop,
}: ConversationScope & {
  /** The RESOLVED policy; `undefined` while the adapter row is still loading. */
  policy: TriggerPolicy | undefined
  providerOverride?: string
  modelOverride?: string
  /** The per-conversation model switcher drives the desktop runtime. */
  desktop: boolean
}) {
  const t = useTranslations("inbox.controls")
  return (
    <>
      {/* A6 — per-channel provider/model override (ADR-0009 v41). */}
      {desktop && (
        <ControlItem label={t("model")} layout={layout} testId="control-model">
          <ProviderModelSwitcher
            conversationKey={conversationKey}
            sessionId={sessionId}
            providerOverride={providerOverride}
            modelOverride={modelOverride}
          />
        </ControlItem>
      )}
      {adapterId && (
        <ControlItem label={t("quietHours")} layout={layout} testId="control-quiet-hours">
          <QuietHoursChip adapterId={adapterId} conversationKey={conversationKey} />
        </ControlItem>
      )}
      {adapterId && (
        <ControlItem label={t("atStrategy")} layout={layout} testId="control-at-strategy">
          <AtStrategyChip adapterId={adapterId} conversationKey={conversationKey} />
        </ControlItem>
      )}
      {adapterId && (
        <ControlItem label={t("topicRuntime")} layout={layout} testId="control-topic-runtime">
          <TopicRuntimeChip adapterId={adapterId} conversationKey={conversationKey} />
        </ControlItem>
      )}
      <ControlItem label={t("policy")} layout={layout} testId="control-policy">
        <PolicyInfo policy={policy} />
      </ControlItem>
    </>
  )
}

/** Adapter health and the newest reply's delivery state. */
export function ConversationHealthControls({
  conversationKey,
  adapterId,
  layout,
}: Omit<ConversationScope, "sessionId">) {
  const t = useTranslations("inbox.controls")
  if (!adapterId) return null
  return (
    <>
      {/* v49 — the wider health surface that picks up breaker / rate-bucket
          signals from the heartbeat snapshots, not just `current.state`. */}
      <ControlItem label={t("health")} layout={layout} testId="control-health">
        <AdapterHealthBadge adapterId={adapterId} />
      </ControlItem>
      {/* Delivery state of the newest outbound job (ADR-0009 §3A.2). Mounted
          once per surface — never per conversation row — so it costs one
          liveQuery, and its retry button is not nested in another control. */}
      <ControlItem label={t("delivery")} layout={layout} testId="control-delivery">
        <OutboundStatusPill conversationKey={conversationKey} />
      </ControlItem>
    </>
  )
}

/**
 * The computer-use opt-in. The biometric toggle needs the desktop shell; other
 * shells get the read-only chip so the elevated permission is still visible.
 */
export function ConversationComputerUseControl({
  conversationKey,
  sessionId,
  adapterId,
  layout,
  overrideRow,
  desktop,
}: ConversationScope & { overrideRow?: ConversationOverrideRow; desktop: boolean }) {
  const t = useTranslations("inbox.controls")
  const active = overrideRow?.allowComputerUse === true
  if (desktop && adapterId) {
    return (
      <ControlItem label={t("computerUse")} layout={layout} testId="control-computer-use">
        <ComputerUseToggle
          conversationKey={conversationKey}
          sessionId={sessionId}
          adapterId={adapterId}
          currentValue={active}
        />
      </ControlItem>
    )
  }
  if (desktop) return null
  return (
    <ControlItem label={t("computerUse")} layout={layout} testId="control-computer-use">
      <ComputerUseChip active={active} />
    </ControlItem>
  )
}
