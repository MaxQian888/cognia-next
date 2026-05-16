"use client"

/**
 * Policy info chip for the Inbox conversation header.
 *
 * Shows a brief tooltip summarising the resolved trigger policy:
 * rules and rate-limit blockers are rendered in human-readable form.
 */

import { useTranslations } from "next-intl"
import { InfoIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { TriggerPolicy, TriggerRule, TriggerBlocker } from "@/types/connectors/policy"

interface PolicyInfoProps {
  policy: TriggerPolicy
}

type Translator = (key: string, values?: Record<string, string | number>) => string

function describeRule(rule: TriggerRule, t: Translator): string {
  switch (rule.kind) {
    case "private-default":
      return t("rules.private-default")
    case "self-mention":
      return t("rules.self-mention")
    case "reply-to-bot":
      return t("rules.reply-to-bot")
    case "slash-command":
      return t("rules.slash-command", { names: rule.prefixes.join(", ") })
    case "keyword":
      return t("rules.keyword", { names: rule.words.join(", ") })
    case "user-allowlist":
      return t("rules.user-allowlist", { names: rule.userIds.join(", ") })
    case "channel-allowlist":
      return t("rules.channel-allowlist", { names: rule.channelIds.join(", ") })
    default:
      return t("rules.unknown")
  }
}

function describeBlocker(blocker: TriggerBlocker, t: Translator): string {
  switch (blocker.kind) {
    case "rate-limit":
      return t("blockers.rate-limit", { perUserPerMin: blocker.perUserPerMin })
    case "cooldown-after-bot-reply":
      return t("blockers.cooldown-after-bot-reply", { secs: blocker.secs })
    case "user-blocklist":
      return t("blockers.user-blocklist", { names: blocker.userIds.join(", ") })
    case "channel-blocklist":
      return t("blockers.channel-blocklist", { names: blocker.channelIds.join(", ") })
    case "keyword-blocklist":
      return t("blockers.keyword-blocklist", { names: blocker.words.join(", ") })
    default:
      return t("blockers.unknown")
  }
}

export function PolicyInfo({ policy }: PolicyInfoProps) {
  const t = useTranslations("inbox.policyInfo")
  const tFn: Translator = (key, values) => t(key, values)
  const ruleParts = policy.rules.map((r) => describeRule(r, tFn))
  const blockerParts = policy.blockers.map((b) => describeBlocker(b, tFn))

  const summary = [...ruleParts, ...blockerParts].join(". ")

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-auto gap-1 px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          data-testid="policy-info-trigger"
          aria-label={t("aria")}
        >
          <InfoIcon className="h-3.5 w-3.5" />
          <span>{t("title")}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs text-xs" data-testid="policy-info-tooltip">
        {summary || t("noRules")}
      </TooltipContent>
    </Tooltip>
  )
}
