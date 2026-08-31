"use client"

/**
 * The version choice that `service.publish` was already asking for.
 *
 * `publish` refuses a `confirmedBump` that does not match its own conservative
 * suggestion, and returns the reasons behind it, precisely so a human sees why
 * a change is major before it becomes major. The Studio fetched the suggestion
 * and handed it straight back as the confirmation, which satisfied the check
 * and defeated the point: no version was ever shown, and no reason was ever
 * read.
 */

import { useTranslations } from "next-intl"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { TemplateVersionBump } from "@/lib/templates/contracts"

export interface PublishSuggestion {
  bump: TemplateVersionBump
  reasons: string[]
  /** Version the release will carry if the suggested bump is accepted. */
  nextVersion: string
  currentVersion: string | null
}

export interface PublishConfirmDialogProps {
  suggestion: PublishSuggestion | null
  onOpenChange: (open: boolean) => void
  onConfirm: (bump: TemplateVersionBump) => void
  busy?: boolean
}

export function PublishConfirmDialog({
  suggestion,
  onOpenChange,
  onConfirm,
  busy = false,
}: PublishConfirmDialogProps) {
  const t = useTranslations("templateStudio.publishDialog")
  const open = suggestion !== null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="template-publish-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {suggestion
              ? t("description", {
                  current: suggestion.currentVersion ?? t("unreleased"),
                  next: suggestion.nextVersion,
                })
              : ""}
          </DialogDescription>
        </DialogHeader>
        {suggestion ? (
          <Alert>
            <AlertTitle>{t(`bump.${suggestion.bump}`)}</AlertTitle>
            <AlertDescription>
              {suggestion.reasons.length > 0 ? (
                <ul className="list-disc space-y-1 pl-4" data-testid="template-publish-reasons">
                  {suggestion.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : (
                t("noReasons")
              )}
            </AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button
            onClick={() => suggestion && onConfirm(suggestion.bump)}
            disabled={busy || !suggestion}
            data-testid="template-publish-confirm"
          >
            {t("confirm", { version: suggestion?.nextVersion ?? "" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
