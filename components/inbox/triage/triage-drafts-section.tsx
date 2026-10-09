"use client"

/**
 * Pending drafts for the previewed conversation, each in an inline editor.
 *
 * Approving a draft is triage, not a conversation: the operator reads what the
 * bot wants to say, edits it, sends or rejects it, and moves on — without
 * opening the chat. Each `DraftEditor` is keyed by draft id so its local edits
 * belong to that draft and vanish with it once approved or rejected (the live
 * queue drops it).
 *
 * The pane passes `suppressKinds={["draft"]}` to the notice area above, so the
 * same draft is not offered twice.
 *
 * Renders nothing while the queue loads or when it is empty: the section is
 * there to surface work, and an empty "Drafts" heading is not work.
 */

import { Fragment, useMemo } from "react"
import { useTranslations } from "next-intl"
import { Separator } from "@/components/ui/separator"
import { usePendingDraftsQuery } from "@/hooks/connectors/use-pending-drafts"
import { DraftEditor } from "../draft-editor"
import { TriageSectionHeading } from "./triage-section-heading"

export interface TriageDraftsSectionProps {
  conversationKey: string
}

export function TriageDraftsSection({ conversationKey }: TriageDraftsSectionProps) {
  const t = useTranslations("inbox.triage.drafts")
  const queue = usePendingDraftsQuery()
  const drafts = useMemo(
    () => (queue ?? []).filter((draft) => draft.conversationKey === conversationKey),
    [queue, conversationKey]
  )

  if (drafts.length === 0) return null

  return (
    <section aria-labelledby="triage-drafts-heading" data-testid="triage-drafts-section">
      <TriageSectionHeading id="triage-drafts-heading">
        {t("title", { count: drafts.length })}
      </TriageSectionHeading>
      <div className="px-4 pb-3">
        {drafts.map((draft, index) => (
          <Fragment key={draft.id}>
            {index > 0 && <Separator className="my-3" />}
            <div data-testid={`triage-draft-${draft.id}`}>
              <DraftEditor draft={draft} />
            </div>
          </Fragment>
        ))}
      </div>
    </section>
  )
}
