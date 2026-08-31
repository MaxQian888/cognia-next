"use client"

/**
 * The conversation header's `⋯` overflow.
 *
 * The header used to lay twenty controls flat in one non-wrapping row. There
 * was no CSS fix available: `buttonVariants` and `badgeVariants` both bake
 * `shrink-0` into their base, so nearly every child refused to compress and
 * the row simply ran past the pane — which `ResizablePanel` clips with
 * `overflow-hidden`, putting the trailing gear and contact buttons out of
 * reach entirely. Removing controls from the strip is the only fix.
 *
 * ## Why a Popover and not a DropdownMenu
 *
 * Six of these controls own an overlay of their own — `LifecycleStatusChip`,
 * `AssigneeChip`, `LabelPicker` and `ProviderModelSwitcher` each mount a
 * `DropdownMenu`; `AdapterHealthBadge` mounts a `Popover`; `ComputerUseToggle`
 * awaits a blocking biometric prompt. Inside a `DropdownMenuContent` all six
 * break: the nested content portals outside the menu's DOM, so every click in
 * it reads as "outside" and closes the parent, unmounting the child mid-flight;
 * non-`menuitem` children also break roving tabindex and typeahead.
 *
 * `components/chat/composer/bottom-toolbar.tsx` hit exactly this and settled on
 * a Popover, whose DismissableLayer stack handles nesting. Inside one, all six
 * work unmodified.
 */

import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { ListChecksIcon, MessageSquareIcon, MoreHorizontalIcon, UserRoundIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useAdapterHealth } from "@/hooks/connectors/use-adapter-health"
import { useLatestOutboundJob } from "@/hooks/connectors/use-latest-outbound-job"
import { useSessions } from "@/hooks/chat/use-sessions"
import { focusSession } from "@/hooks/global-search/use-global-search-actions"
import { getSession } from "@/lib/db/sessions"
import { decideBadge } from "./adapter-health-decision"
import { effectiveStatus } from "@/lib/db/conversation-overrides"
import type { ConversationOverrideRow, OutboundJobStatus } from "@/lib/db/connector-types"
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

/** Outbound statuses that mean "the last reply did NOT (verifiably) go out". */
const OUTBOUND_ATTENTION_STATUSES: ReadonlySet<OutboundJobStatus> = new Set([
  "failed",
  "deadlettered",
  "delivery_unknown",
])

/**
 * Whether the `⋯` should carry an attention dot — i.e. whether anything behind
 * it differs from the quiet default. Pure so it can be covered without
 * driving the popover open. `latestOutboundStatus` is the newest outbound
 * job's status for this conversation (ADR-0009 §3A.2): a failed /
 * dead-lettered / ambiguous delivery lights the dot so the operator opens the
 * popover and finds the delivery pill.
 */
export function hasOverflowAttention(
  row: ConversationOverrideRow | undefined,
  healthDegraded: boolean,
  latestOutboundStatus?: OutboundJobStatus | null
): boolean {
  if (healthDegraded) return true
  if (latestOutboundStatus && OUTBOUND_ATTENTION_STATUSES.has(latestOutboundStatus)) return true
  if (effectiveStatus(row) !== "open") return true
  if (row?.assignee) return true
  if ((row?.labelIds?.length ?? 0) > 0) return true
  if (row?.allowComputerUse === true) return true
  return false
}

/** Labelled group inside the popover. Hides itself when it has no children. */
function OverflowGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5 empty:hidden">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

export interface ConversationHeaderOverflowProps {
  conversationKey: string
  sessionId: string
  /** Parsed from the conversationKey by the header; "" when unparseable. */
  adapterId: string
  /** The RESOLVED policy; `undefined` while the adapter row is still loading. */
  policy: TriggerPolicy | undefined
  overrideRow?: ConversationOverrideRow
  providerOverride?: string
  modelOverride?: string
  /** Desktop-only surfaces are gated on this (Tauri shell). */
  desktop: boolean
  onOpenContact: () => void
  onOpenBindings: () => void
}

export function ConversationHeaderOverflow({
  conversationKey,
  sessionId,
  adapterId,
  policy,
  overrideRow,
  providerOverride,
  modelOverride,
  desktop,
  onOpenContact,
  onOpenBindings,
}: ConversationHeaderOverflowProps) {
  const t = useTranslations("inbox.conversationHeader")
  const tBindings = useTranslations("inbox.bindingsInspector")
  const router = useRouter()
  const { select } = useSessions()
  // The reverse of the chat header's "open in Inbox": follow the session into
  // its workspace + guild (the shared ⌘K primitive), focus it, and leave for
  // the main chat. The row is read at click time — the header only holds the
  // id, and the workspace / guild hop needs the session's projectId + kind.
  const openInChat = async () => {
    const session = await getSession(sessionId)
    focusSession(session, sessionId, select)
    router.push("/")
  }
  // Resolved here rather than inside AdapterHealthBadge so the attention dot
  // can reflect a degraded adapter while the popover is still closed.
  const health = useAdapterHealth(adapterId || null)
  // Newest outbound job — resolved here (not inside the pill) for the same
  // reason as health: the dot must light while the popover is closed.
  const latestOutbound = useLatestOutboundJob(conversationKey)
  const attention = hasOverflowAttention(
    overrideRow,
    decideBadge(health) !== null,
    latestOutbound?.status ?? null
  )
  const label = attention ? t("moreAttention") : t("more")

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="relative size-7 shrink-0"
              aria-label={label}
              data-testid="conversation-header-more"
            >
              <MoreHorizontalIcon className="size-3.5" />
              {attention && (
                <span
                  aria-hidden
                  data-testid="conversation-header-more-dot"
                  className="absolute right-1 top-1 size-1.5 rounded-full bg-primary"
                />
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>

      <PopoverContent
        align="end"
        className="w-72 space-y-3 p-3"
        data-testid="conversation-header-overflow"
      >
        <OverflowGroup label={t("groupStatus")}>
          <LifecycleStatusChip
            conversationKey={conversationKey}
            sessionId={sessionId}
            status={effectiveStatus(overrideRow)}
          />
          <AssigneeChip
            conversationKey={conversationKey}
            sessionId={sessionId}
            adapterId={adapterId || undefined}
            assignee={overrideRow?.assignee}
          />
          <SlaBadge
            nextResponseDueAt={overrideRow?.nextResponseDueAt}
            status={effectiveStatus(overrideRow)}
            escalatedStep={overrideRow?.escalatedStep}
          />
          <PendingApprovalChip sessionId={sessionId} />
          <LabelPicker
            conversationKey={conversationKey}
            sessionId={sessionId}
            selectedIds={overrideRow?.labelIds ?? []}
          />
          <LastInboundChip conversationKey={conversationKey} />
          {/* Renders only while a delegated run is in flight, which is the one
              piece of this conversation's state that lives outside the thread. */}
          <ActiveDelegationsChip conversationKey={conversationKey} />
        </OverflowGroup>

        <OverflowGroup label={t("groupRouting")}>
          {/* A6 — per-channel provider/model override (ADR-0009 v41). */}
          {desktop && (
            <ProviderModelSwitcher
              conversationKey={conversationKey}
              sessionId={sessionId}
              providerOverride={providerOverride}
              modelOverride={modelOverride}
            />
          )}
          {adapterId && <QuietHoursChip adapterId={adapterId} conversationKey={conversationKey} />}
          {adapterId && <AtStrategyChip adapterId={adapterId} conversationKey={conversationKey} />}
          {adapterId && (
            <TopicRuntimeChip adapterId={adapterId} conversationKey={conversationKey} />
          )}
          <PolicyInfo policy={policy} />
        </OverflowGroup>

        {adapterId && (
          <OverflowGroup label={t("groupHealth")}>
            {/* v49 — the wider health surface that picks up breaker /
                rate-bucket signals from the heartbeat snapshots, not just
                `current.state`. */}
            <AdapterHealthBadge adapterId={adapterId} />
            {/* Delivery state of the newest outbound job (ADR-0009 §3A.2).
                Mounted once here — never per conversation row — so it costs
                one liveQuery, not one per row, and its retry button is not
                nested inside another interactive element. */}
            <OutboundStatusPill conversationKey={conversationKey} />
          </OverflowGroup>
        )}

        <OverflowGroup label={t("groupTools")}>
          {adapterId && desktop && (
            <ComputerUseToggle
              conversationKey={conversationKey}
              sessionId={sessionId}
              adapterId={adapterId}
              currentValue={overrideRow?.allowComputerUse === true}
            />
          )}
          {/* Web-mode mirror of the computer-use opt-in — read-only chip so the
              operator still sees the elevated-permission state even when the
              biometric toggle isn't available (web build / mobile shell). */}
          {!desktop && <ComputerUseChip active={overrideRow?.allowComputerUse === true} />}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() => void openInChat()}
            data-testid="conversation-header-open-in-chat"
          >
            <MessageSquareIcon className="size-3.5" aria-hidden />
            {t("openInChat")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={onOpenContact}
            data-testid="conversation-header-contact"
          >
            <UserRoundIcon className="size-3.5" aria-hidden />
            {t("openContact")}
          </Button>
          {/* A2UI callback-bindings inspector — diagnostic surface for triaging
              "the button didn't route my surface". Desktop-only because the row
              "test" action drives the live bus runtime. */}
          {adapterId && desktop && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              onClick={onOpenBindings}
              data-testid="conversation-header-bindings"
            >
              <ListChecksIcon className="size-3.5" aria-hidden />
              {tBindings("openInspector")}
            </Button>
          )}
        </OverflowGroup>
      </PopoverContent>
    </Popover>
  )
}
