"use client"

/**
 * Manage the issue label catalogue.
 *
 * The tracker seeds five labels at boot and, until now, offered no way to
 * reach any of them: no create, no rename, no recolour, no reorder — and
 * `deleteLabel` refuses a built-in, so all five were permanent. Combined with
 * `addIssueLabel` having no caller either, the whole label feature rendered
 * nothing and did nothing.
 *
 * Opened from the rail's Labels section, which is where a user is already
 * looking at the list they want to change.
 */

import { useTranslations } from "next-intl"

import { LabelCatalogueEditor } from "@/components/labels/label-catalogue-editor"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { LabelRow } from "@/types/labels"

export interface ManageLabelsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Local labels only — GitHub's projections are not editable here. */
  labels: readonly LabelRow[]
}

export function ManageLabelsDialog({ open, onOpenChange, labels }: ManageLabelsDialogProps) {
  const t = useTranslations("issues.labels")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="manage-labels-dialog">
        <DialogHeader>
          <DialogTitle>{t("manageTitle")}</DialogTitle>
        </DialogHeader>
        <LabelCatalogueEditor
          scope="issue"
          labels={labels}
          testId="issue-labels"
          // Issue labels are oklch theme tokens, not free hex: a native colour
          // input would silently rewrite them and lose the theme.
          colorMode="palette"
          strings={{
            title: t("manageTitle"),
            description: t("manageDescription"),
            nameLabel: t("nameLabel"),
            namePlaceholder: t("namePlaceholder"),
            colorLabel: t("colorLabel"),
            addButton: t("addButton"),
            nameRequired: t("nameRequired"),
            empty: t("none"),
            builtinBadge: t("builtinBadge"),
            rowNameAria: (name) => t("rowNameAria", { name }),
            rowColorAria: (name) => t("rowColorAria", { name }),
            deleteAria: (name) => t("deleteAria", { name }),
            reorderAria: (name) => t("reorderAria", { name }),
            swatchAria: (index) => t(`colors.${index}`),
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
