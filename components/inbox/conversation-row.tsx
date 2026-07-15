"use client"

/**
 * A single conversation row in the Inbox middle pane.
 *
 * Layout (master-list density, IM/email-client style):
 *   [avatar+platform]  Title              relative-time
 *                      last-message…      draft · unread · CU
 *
 * Avatar is a deterministic glyph (`lib/ui/avatar`) seeded by the conversation
 * title so legacy sessions without a stored avatar still get a stable hue,
 * with the `PlatformBadge` tucked into the corner. The secondary line shows
 * the latest message preview instead of the raw conversationKey.
 *
 * Extracted from `conversation-list.tsx` so it can carry its own test and keep
 * the list component focused on querying/sorting. The click target stays a
 * single `<button>` with the per-row plugin actions kept *outside* it to avoid
 * nested-interactive a11y violations.
 */

import { useFormatter, useNow, useTranslations } from "next-intl"
import { PinIcon } from "lucide-react"
import type { ConversationStatus } from "@/lib/db/conversation-overrides"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"
import type { ChatSession } from "@cognia/agent-config-types"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { PlatformBadge } from "./platform-badge"
import { UnreadPill } from "./unread-pill"
import { ComputerUseChip } from "./computer-use-chip"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"

export interface ConversationRowItem {
  session: ChatSession
  override: ConversationOverrideRow | undefined
  unreadCount: number
  /** Plaintext snippet of the most recent message, when available. */
  lastMessagePreview?: string
  /** Wall-clock ms of the most recent message, for the relative-time stamp. */
  lastMessageAt?: number
}

export interface ConversationRowProps {
  item: ConversationRowItem
  /** Pending-draft count for this conversation (badge); 0 hides it. */
  draftCount?: number
  isActive: boolean
  onSelect: (conversationKey: string) => void
}

/** Dot color for the non-"open" lifecycle statuses surfaced in the row. */
const ROW_STATUS_DOT: Record<Exclude<ConversationStatus, "open">, string> = {
  pending: "bg-amber-500",
  snoozed: "bg-sky-500",
  resolved: "bg-muted-foreground",
}

export function ConversationRow({
  item,
  draftCount = 0,
  isActive,
  onSelect,
}: ConversationRowProps) {
  const t = useTranslations("inbox.conversationRow")
  const tStatus = useTranslations("inbox.lifecycle.status")
  const format = useFormatter()
  // Anchor relativeTime to a stable render-time "now" so next-intl doesn't fall
  // back to reading the wall clock at format time (ENVIRONMENT_FALLBACK warning
  // + non-deterministic SSR/hydration output).
  const now = useNow()
  const { session, override, unreadCount, lastMessagePreview, lastMessageAt } = item
  const ck = session.platformBinding!.conversationKey
  const platform = session.platformBinding!.platform as PlatformKind
  const adapterId = session.platformBinding!.adapterId
  const name = session.title || ck
  const relative =
    typeof lastMessageAt === "number" ? format.relativeTime(new Date(lastMessageAt), now) : null

  return (
    <div
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 min-h-12 hover:bg-muted/60 transition-colors",
        "md:min-h-11 md:py-1.5",
        isActive && "bg-muted"
      )}
      data-testid={`conversation-row-${ck}`}
    >
      <button
        type="button"
        className="flex-1 min-w-0 flex items-center gap-2.5 text-left"
        onClick={() => onSelect(ck)}
        aria-label={t("openConversation", { name })}
        data-testid={`conversation-row-button-${ck}`}
      >
        {/* Deterministic glyph avatar + platform corner badge */}
        <span className="relative shrink-0">
          <span
            className="flex size-9 items-center justify-center rounded-full text-xs font-medium text-white"
            style={{ backgroundColor: avatarColor({ name }) }}
            aria-hidden
          >
            {avatarGlyph({ name })}
          </span>
          <span className="absolute -bottom-1 -end-1 rounded-full bg-background p-0.5 leading-none">
            <PlatformBadge platform={platform} iconOnly />
          </span>
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1">
            {override?.pinned && <PinIcon className="h-3 w-3 shrink-0 text-muted-foreground" />}
            {override?.status && override.status !== "open" && (
              <span
                className={cn("size-2 shrink-0 rounded-full", ROW_STATUS_DOT[override.status])}
                title={tStatus(override.status)}
                aria-label={t("statusAria", { status: tStatus(override.status) })}
                data-testid={`conversation-row-status-${ck}`}
              />
            )}
            <span className="text-sm font-medium truncate">{name}</span>
          </div>
          <p className="text-xs text-muted-foreground truncate">
            {lastMessagePreview && lastMessagePreview.length > 0
              ? lastMessagePreview
              : t("noPreview")}
          </p>
        </div>

        {/* Right column: relative time + status badges */}
        <div className="flex flex-col items-end gap-1 shrink-0">
          {relative && (
            <span
              className="text-[11px] text-muted-foreground whitespace-nowrap"
              data-testid={`conversation-row-time-${ck}`}
            >
              {relative}
            </span>
          )}
          <div className="flex items-center gap-1">
            {draftCount > 0 && (
              <Badge
                variant="warning"
                className="h-4 px-1 text-[10px] leading-none"
                aria-label={t("draftCountAria", { count: draftCount })}
                data-testid={`conversation-row-draft-${ck}`}
              >
                {t("draftCount", { count: draftCount })}
              </Badge>
            )}
            <UnreadPill count={unreadCount} />
            <ComputerUseChip active={override?.allowComputerUse === true} />
          </div>
        </div>
      </button>

      {/* Plugin contributions: per-row actions (archive, mute, transfer to
       * workflow, …). Hidden when no plugin contributes. */}
      <PluginExtensionSlot
        point="inbox.conversation.actions"
        className="ml-auto flex items-center gap-1 empty:hidden"
        context={{
          conversationKey: ck,
          adapterId,
          platform,
          sessionId: session.id,
          pinned: !!override?.pinned,
          archived: !!override?.archived,
        }}
      />
    </div>
  )
}
