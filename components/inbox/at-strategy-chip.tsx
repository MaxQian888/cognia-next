"use client"

/**
 * Group-admission chip for the conversation header.
 *
 * Answers "will this bot even see what I type here" — the question behind most
 * "the bot is ignoring me" reports. It resolves the same
 * `InboundActivationPolicy` the bus admits on
 * (`resolveInboundActivationPolicy`), across both layers, so it reports what
 * actually happens rather than a field's raw value.
 *
 * It used to read `AdapterInstanceRow.atResponseStrategy` directly. The
 * settings UI writes `inboundActivationPolicy` and has for some time, so the
 * chip was empty for every adapter configured through the current forms —
 * exactly the ones an operator would be looking at.
 */

import { useTranslations } from "next-intl"
import { InboxChip } from "./inbox-chip"
import { AtSignIcon } from "lucide-react"
import { useAdapterInstance } from "@/hooks/connectors/use-adapter-instance"
import { useConversationOverride } from "@/hooks/connectors/use-conversation-overrides"
import { resolveInboundActivationPolicy } from "@/lib/connectors/conversation-admission"

interface AtStrategyChipProps {
  adapterId: string
  /** Present on the conversation header; its override outranks the bot's. */
  conversationKey?: string
}

export function AtStrategyChip({ adapterId, conversationKey }: AtStrategyChipProps) {
  const t = useTranslations("inbox.atStrategy")
  const adapter = useAdapterInstance(adapterId)
  const override = useConversationOverride(conversationKey)

  // Nothing to report until the bot's row is readable — a chip claiming a
  // policy the row has not confirmed is the failure this replaced.
  if (!adapter) return null

  const policy = resolveInboundActivationPolicy(adapter, override)
  const label = t(policy)
  const scope = override?.inboundActivationPolicy ? "conversation" : "adapter"

  return (
    <InboxChip
      icon={<AtSignIcon className="size-3" />}
      aria-label={t("aria", { strategy: label })}
      data-testid="at-strategy-chip"
      dataAttributes={{ "data-policy": policy }}
      tooltip={t(`tooltip.${scope}`, { strategy: label })}
    >
      {label}
    </InboxChip>
  )
}
