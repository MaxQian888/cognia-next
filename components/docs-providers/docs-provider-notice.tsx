"use client"

/**
 * "You cannot read remote documents from here, and here is why."
 *
 * The localized read-out for `lib/docs-providers/reach.ts`, and the
 * replacement for `docsProviders.settings.desktopOnly` plus
 * `docsProviders.picker.hostUnsupported`. Those two strings said the same flat
 * thing to a phone whose paired desktop was holding the credentials.
 *
 * Presentation comes from `UnavailableNotice`, the same primitive the
 * connector host notice renders through, so a blocked document source and a
 * blocked bot control look like one product. Only the vocabulary differs, and
 * that difference is the point (see the module docstring on `reach.ts`).
 */

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"

import { UnavailableNotice } from "@/components/connectors/unavailable-notice"
import { useHostProfile } from "@/hooks/use-host-profile"
import { docsProviderReach, type DocsProviderReach } from "@/lib/docs-providers/reach"
import type { DocsProvider } from "@/lib/docs-providers"

/** Reach for one provider on the host this component is rendering in. */
export function useDocsProviderReach(provider: Pick<DocsProvider, "hosts">): DocsProviderReach {
  return docsProviderReach(provider, useHostProfile())
}

export interface DocsProviderNoticeProps {
  reach: DocsProviderReach
  /** Rendered after the text, typically a button performing the next step. */
  action?: ReactNode
  className?: string
  "data-testid"?: string
}

/**
 * Renders nothing when reading IS possible. Every call site holds a reach that
 * is usually fine, so the guard belongs here rather than at each of them.
 */
export function DocsProviderNotice({
  reach,
  action,
  className,
  "data-testid": testId = "docs-provider-notice",
}: DocsProviderNoticeProps) {
  const t = useTranslations("docsProviders.reach")
  if (reach.available || !reach.block) return null
  return (
    <UnavailableNotice
      reason={t(`block.${reach.block}`)}
      nextStep={t(`nextStep.${reach.block}`)}
      cause={reach.block}
      action={action}
      className={className}
      data-testid={testId}
    />
  )
}

/**
 * One-line variant for dense surfaces (a menu row's subtitle, a picker's empty
 * state) where the full reason plus next step would not fit. Same vocabulary,
 * shorter sentence, so the two never disagree.
 */
export function useDocsProviderBlockLabel(reach: DocsProviderReach): string | null {
  const t = useTranslations("docsProviders.reach")
  if (reach.available || !reach.block) return null
  return t(`short.${reach.block}`)
}
