"use client"

/**
 * Stub designer wrapper for the artifact panel.
 *
 * Cognia ships a v0-style visual designer that opens for `html`, `react`,
 * and `svg` artifacts. cognia-next does not yet include the designer
 * subsystem; we render a small notice so the panel's "Preview in Designer"
 * action still has somewhere to land if a future build flips it on.
 */

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useTranslations } from "next-intl"
import type { Artifact } from "@/types"

interface ArtifactDesignerWrapperProps {
  artifact: Artifact
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ArtifactDesignerWrapper({
  artifact,
  open,
  onOpenChange,
}: ArtifactDesignerWrapperProps) {
  const t = useTranslations("artifacts")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("designerUnsupportedTitle")}</DialogTitle>
        </DialogHeader>
        <Alert>
          <AlertDescription>
            {t("designerUnsupportedDescription", { title: artifact.title })}
          </AlertDescription>
        </Alert>
      </DialogContent>
    </Dialog>
  )
}
