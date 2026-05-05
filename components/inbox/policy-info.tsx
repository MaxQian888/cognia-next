"use client"

/**
 * Policy info chip for the Inbox conversation header.
 *
 * Shows a brief tooltip summarising the resolved trigger policy:
 * rules and rate-limit blockers are rendered in human-readable form.
 */

import { InfoIcon } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { TriggerPolicy, TriggerRule, TriggerBlocker } from "@/types/connectors/policy"

interface PolicyInfoProps {
  policy: TriggerPolicy
}

function describeRule(rule: TriggerRule): string {
  switch (rule.kind) {
    case "private-default":
      return "All private messages"
    case "self-mention":
      return "@mention"
    case "reply-to-bot":
      return "Reply-to-bot"
    case "slash-command":
      return `Commands: ${rule.prefixes.join(", ")}`
    case "keyword":
      return `Keywords: ${rule.words.join(", ")}`
    case "user-allowlist":
      return `Users: ${rule.userIds.join(", ")}`
    case "channel-allowlist":
      return `Channels: ${rule.channelIds.join(", ")}`
    default:
      return "Unknown rule"
  }
}

function describeBlocker(blocker: TriggerBlocker): string {
  switch (blocker.kind) {
    case "rate-limit":
      return `Rate-limited to ${blocker.perUserPerMin}/min per user`
    case "cooldown-after-bot-reply":
      return `${blocker.secs}s cooldown after bot reply`
    case "user-blocklist":
      return `Blocked users: ${blocker.userIds.join(", ")}`
    case "channel-blocklist":
      return `Blocked channels: ${blocker.channelIds.join(", ")}`
    case "keyword-blocklist":
      return `Blocked keywords: ${blocker.words.join(", ")}`
    default:
      return "Unknown blocker"
  }
}

export function PolicyInfo({ policy }: PolicyInfoProps) {
  const ruleParts = policy.rules.map(describeRule)
  const blockerParts = policy.blockers.map(describeBlocker)

  const summary = [...ruleParts, ...blockerParts].join(". ")

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          data-testid="policy-info-trigger"
          aria-label="Policy info"
        >
          <InfoIcon className="h-3.5 w-3.5" />
          <span>Policy</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs text-xs" data-testid="policy-info-tooltip">
        {summary || "No trigger rules configured."}
      </TooltipContent>
    </Tooltip>
  )
}
