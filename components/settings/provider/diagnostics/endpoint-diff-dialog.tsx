"use client"

import { useTranslations } from "next-intl"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

export interface EndpointDiffDialogProps {
  /** The endpoint awaiting confirmation; `null` closes the dialog. */
  pendingEndpoint: string | null
  currentEndpoint: string
  onCancel: () => void
  onConfirm: (endpoint: string) => void
}

/**
 * Before/after diff for an endpoint switch.
 *
 * Switching the base URL silently re-points every future request for the
 * provider, so the exact strings are shown side by side rather than described —
 * a trailing `/v1` is the difference between working and broken.
 */
export function EndpointDiffDialog({
  pendingEndpoint,
  currentEndpoint,
  onCancel,
  onConfirm,
}: EndpointDiffDialogProps) {
  const t = useTranslations("providers.diagnostics")

  return (
    <AlertDialog open={pendingEndpoint !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("endpoints.diffTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("endpoints.diffDescription")}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-2 rounded-lg border p-3 text-sm">
          <div>
            <span className="text-muted-foreground">{t("endpoints.before")}: </span>
            <code className="break-all">{currentEndpoint}</code>
          </div>
          <div>
            <span className="text-muted-foreground">{t("endpoints.after")}: </span>
            <code className="break-all">{pendingEndpoint}</code>
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("confirm.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (pendingEndpoint) onConfirm(pendingEndpoint)
            }}
          >
            {t("endpoints.confirmApply")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
