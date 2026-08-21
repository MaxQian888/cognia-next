"use client"

/**
 * Settings → Connections → Labels. Manage the conversation-label catalogue
 * (CRM, schema v83): create, recolour, rename, reorder, delete. Built-in
 * starter labels are protected from deletion.
 *
 * The editor itself lives in `components/labels/label-catalogue-editor.tsx`,
 * shared with the issue tracker's own catalogue. This file supplies the scope
 * and this namespace's strings, and nothing else — the two catalogues had
 * started to need the same controls, and a second copy would have drifted.
 */

import { useTranslations } from "next-intl"

import { LabelCatalogueEditor } from "@/components/labels/label-catalogue-editor"
import { useConversationLabels } from "@/hooks/connectors/use-conversation-labels"

export function LabelsTab() {
  const t = useTranslations("settings.connections.labels")
  const labels = useConversationLabels()

  return (
    <LabelCatalogueEditor
      scope="conversation"
      labels={labels}
      testId="labels"
      // Conversation labels have always stored free hex from a native picker.
      colorMode="hex"
      strings={{
        title: t("title"),
        description: t("description"),
        nameLabel: t("nameLabel"),
        namePlaceholder: t("namePlaceholder"),
        colorLabel: t("colorLabel"),
        addButton: t("addButton"),
        nameRequired: t("nameRequired"),
        empty: t("empty"),
        builtinBadge: t("builtinBadge"),
        rowNameAria: (name) => t("rowNameAria", { name }),
        rowColorAria: (name) => t("rowColorAria", { name }),
        deleteAria: (name) => t("deleteAria", { name }),
        reorderAria: (name) => t("reorderAria", { name }),
      }}
    />
  )
}
