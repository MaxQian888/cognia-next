"use client"

// Saved chat templates on the phone.
//
// Not `PairedOnly`. The table is device-local, the composer on this device can
// save into it, and every action on the page (edit, duplicate, export, import,
// delete) is a local write. Gating it on a desktop pairing would hide the
// phone's OWN templates behind a machine that has nothing to do with them.
//
// "Save to repository" is the one action that needs a host, and it refuses on
// its own terms when there is no workspace root to write into, which is the
// honest answer rather than a hidden button.

import { useTranslations } from "next-intl"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { ChatTemplatesSection } from "@/components/settings/chat-templates-section"

export default function MobileChatTemplatesPage() {
  const t = useTranslations("mobile.chatTemplates")
  return (
    <SubPageShell title={t("title")} backAria={t("backAria")} testid="mobile-chat-templates-page">
      <ChatTemplatesSection mobile />
    </SubPageShell>
  )
}
