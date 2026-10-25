"use client"

/**
 * Who an outbound tool call delivers to, as an approval card names it
 * (ADR-0239).
 *
 * Shared by every card that answers an outbound ask: the desktop decision
 * surface and the phone's parked-run card. The recipients come from the
 * outbound policy's plan, never from the model's description of the call.
 * Nothing on the host records chat or member names, so a recipient is shown
 * by its kind, its id on the platform and the bot it goes through; a public
 * link and a recipient the tool's input did not name are said to be exactly
 * that.
 */

import { useTranslations } from "next-intl"
import { SendIcon } from "lucide-react"

import type { PendingOutboundTarget } from "@cognia/agent-config-types"
import { outboundRecipientId } from "@/lib/policy/action-review/outbound-targets"
import { cn } from "@/lib/utils"

export interface OutboundRecipientsProps {
  targets: readonly PendingOutboundTarget[]
  /** Say that a deny also fences these recipients for the rest of the request. */
  fenceNotice?: boolean
  className?: string
}

export function OutboundRecipients({ targets, fenceNotice, className }: OutboundRecipientsProps) {
  const t = useTranslations("chat.toolApproval")
  const label = (target: PendingOutboundTarget) => {
    const id = outboundRecipientId(target)
    switch (target.kind) {
      case "conversation":
        return t("recipientConversation", { id, channel: target.channel })
      case "person":
        return t("recipientPerson", { id, channel: target.channel })
      case "mail":
        return t("recipientMail", { address: id })
      case "repository":
        return target.thread
          ? t("recipientRepositoryThread", { id, thread: target.thread })
          : t("recipientRepository", { id })
      case "site":
        return t("recipientSite", { origin: id })
      case "public":
        return t("recipientPublic", { tool: id })
      case "unknown":
        return t("recipientUnknown")
    }
  }

  return (
    <div className={cn("space-y-1.5", className)} data-testid="outbound-recipients">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <SendIcon className="size-3" aria-hidden="true" />
        {t("recipientsLabel")}
      </p>
      <ul className="space-y-1">
        {targets.map((target) => (
          <li
            key={`${target.channel}|${target.recipient}`}
            className="break-all rounded bg-muted px-2 py-1 font-mono text-xs"
            data-testid="outbound-recipient"
            data-kind={target.kind}
          >
            {label(target)}
          </li>
        ))}
      </ul>
      {fenceNotice ? (
        <p className="text-xs text-muted-foreground" data-testid="outbound-deny-fences">
          {t("denyFencesNotice")}
        </p>
      ) : null}
    </div>
  )
}
