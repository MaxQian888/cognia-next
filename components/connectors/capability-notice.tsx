"use client"

/**
 * The single localized read-out for "this bot cannot do that, and here is why".
 *
 * Before this, the six causes in `lib/connectors/capability-availability.ts`
 * reached the screen in exactly one place — the adapter's capability matrix
 * card — and every other consumer expressed them by disappearing. So the same
 * fact ("your Slack grant is missing `channels:history`") produced a full
 * sentence in one screen and a missing button in another, and only the screen
 * nobody visits while troubleshooting had the sentence.
 *
 * Reason and next step are deliberately two sentences rather than one string.
 * Two of the six causes have no next step at all, and a vocabulary that folded
 * the remedy into the reason could not express that difference — it would
 * either invent a remedy for a platform limit or drop the remedy from the four
 * causes that have one. `isActionableCause` decides which; the catalogue test
 * pins both halves against the real union, because these are template-literal
 * keys and `lint:i18n` cannot see them.
 *
 * Capability ids and details (scope names, setting keys, transport names) stay
 * verbatim, for the same reason `ConnectedScopesCard` shows raw scopes: they
 * are identifiers the operator matches against the platform's own console, and
 * translating them would make them unsearchable.
 *
 * The layout lives in `UnavailableNotice`, shared with `ConnectorHostNotice`.
 * The two vocabularies stay separate — see that module for why.
 */

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"

import { UnavailableNotice } from "@/components/connectors/unavailable-notice"
import {
  isActionableCause,
  type CapabilityUnavailable,
  type CapabilityUnavailableCause,
} from "@/lib/connectors/capability-availability"

export interface CapabilityUnavailableText {
  reason: string
  /** `null` for the two causes with nothing to do about them. */
  nextStep: string | null
}

/**
 * Localize one cause. Exported so the capability matrix card can render the
 * same words in its own compact list instead of keeping a second vocabulary.
 */
export function useCapabilityUnavailableText(): (
  cause: CapabilityUnavailableCause,
  detail?: string
) => CapabilityUnavailableText {
  const t = useTranslations("connectors.capability")
  return (cause, detail) => ({
    reason: t(`reason.${cause}`, { detail: detail ?? "" }),
    nextStep: isActionableCause(cause) ? t(`nextStep.${cause}`) : null,
  })
}

export interface CapabilityNoticeProps {
  availability: CapabilityUnavailable
  /** Rendered after the text — a button that performs the next step, when one exists. */
  action?: ReactNode
  className?: string
  "data-testid"?: string
}

export function CapabilityNotice({
  availability,
  action,
  className,
  "data-testid": testId = "capability-notice",
}: CapabilityNoticeProps) {
  const describe = useCapabilityUnavailableText()
  const { reason, nextStep } = describe(availability.cause, availability.detail)

  return (
    <UnavailableNotice
      reason={reason}
      nextStep={nextStep}
      cause={availability.cause}
      action={action}
      className={className}
      data-testid={testId}
    />
  )
}
