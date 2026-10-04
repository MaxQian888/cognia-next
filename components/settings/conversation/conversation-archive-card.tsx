"use client"

/**
 * Settings → Conversation → "Archive": the conversation auto-archive policy.
 *
 * A thin card around {@link AutoArchiveControl}, the same control the
 * conversation manager's Archived tab shows inline, so the two can never offer
 * different choices or explain the policy differently. Sits right after the
 * sidebar card: one decides how a row looks, this one when a row leaves the
 * active list.
 */

import { useTranslations } from "next-intl"
import { ArchiveIcon } from "lucide-react"

import { AutoArchiveControl } from "@/components/conversations/auto-archive-control"
import { SettingsCard } from "../common/settings-section"

export function ConversationArchiveCard() {
  const t = useTranslations("conversations.autoArchive.card")
  return (
    <SettingsCard
      icon={<ArchiveIcon className="size-5" />}
      title={t("title")}
      description={t("description")}
    >
      <AutoArchiveControl variant="card" />
    </SettingsCard>
  )
}

export default ConversationArchiveCard
