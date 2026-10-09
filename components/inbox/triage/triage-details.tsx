"use client"

/**
 * "Routing & health" for the previewed conversation — collapsed by default.
 *
 * The routing and health controls a triager needs only when something is off:
 * model, quiet hours, @-strategy, topic runtime, trigger policy, adapter
 * health, the newest reply's delivery state, the computer-use opt-in, the
 * per-conversation settings dialog and (desktop) the callback-bindings
 * inspector. They are the same groups the chat header's `⋯` renders
 * (`conversation-control-groups.tsx`), laid out as a definition list.
 *
 * The disclosure carries the same health attention rule as the `⋯` dot
 * (`hasHealthAttention`), so a degraded adapter or a failed reply is visible
 * while the section is closed.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronRightIcon, ListChecksIcon, Settings2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useAdapterHealth } from "@/hooks/connectors/use-adapter-health"
import { useLatestOutboundJob } from "@/hooks/connectors/use-latest-outbound-job"
import type { TriageConversation } from "@/hooks/inbox/use-triage-conversation"
import { cn } from "@/lib/utils"
import { decideBadge } from "../adapter-health-decision"
import { hasHealthAttention } from "../conversation-header-overflow"
import {
  ControlList,
  ConversationComputerUseControl,
  ConversationHealthControls,
  ConversationRoutingControls,
} from "../conversation-control-groups"

export interface TriageDetailsProps {
  conversation: TriageConversation
  /** Desktop-only controls (model switcher, biometric toggle, bindings) gate on this. */
  desktop: boolean
  onOpenSettings: () => void
  onOpenBindings: () => void
}

export function TriageDetails({
  conversation,
  desktop,
  onOpenSettings,
  onOpenBindings,
}: TriageDetailsProps) {
  const t = useTranslations("inbox.triage.details")
  const [open, setOpen] = useState(false)
  const { session, conversationKey, adapterId, override, policy } = conversation
  const health = useAdapterHealth(adapterId || null)
  const latestOutbound = useLatestOutboundJob(conversationKey)
  const attention = hasHealthAttention(decideBadge(health) !== null, latestOutbound?.status ?? null)

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid="triage-details">
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-9 w-full justify-start gap-1.5 rounded-none px-4 text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
          data-testid="triage-details-toggle"
        >
          <ChevronRightIcon
            className={cn("size-3.5 transition-transform", open && "rotate-90")}
            aria-hidden
          />
          {t("title")}
          {attention && (
            <span
              className="ms-1 size-1.5 rounded-full bg-primary"
              role="img"
              aria-label={t("attention")}
              data-testid="triage-details-attention"
            />
          )}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-4 pb-3">
        <ControlList aria-label={t("title")}>
          <ConversationRoutingControls
            layout="list"
            conversationKey={conversationKey}
            sessionId={session.id}
            adapterId={adapterId}
            policy={policy}
            providerOverride={override?.providerOverride}
            modelOverride={override?.modelOverride}
            desktop={desktop}
          />
          <ConversationHealthControls
            layout="list"
            conversationKey={conversationKey}
            adapterId={adapterId}
          />
          <ConversationComputerUseControl
            layout="list"
            conversationKey={conversationKey}
            sessionId={session.id}
            adapterId={adapterId}
            overrideRow={override}
            desktop={desktop}
          />
        </ControlList>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={onOpenSettings}
            data-testid="triage-open-settings"
          >
            <Settings2Icon className="size-3.5" aria-hidden />
            {t("settings")}
          </Button>
          {/* The inspector's "test" action drives the live bus runtime, which
              only the desktop shell runs. */}
          {adapterId && desktop && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              onClick={onOpenBindings}
              data-testid="triage-open-bindings"
            >
              <ListChecksIcon className="size-3.5" aria-hidden />
              {t("bindings")}
            </Button>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
