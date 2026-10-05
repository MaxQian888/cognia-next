"use client"

/**
 * The confirmation before a Host configuration is removed, shared by the list
 * card's overflow menu and the detail screen so both name the agent the same
 * way and nothing is removed on a single tap.
 */

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
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"

import { hostAgentName } from "./host-agent-family"

export interface RemoveHostAgentDialogProps {
  /** The configuration awaiting confirmation; `null` keeps the dialog closed. */
  record: ExternalAgentConfigRecord | null
  onCancel: () => void
  onConfirm: (record: ExternalAgentConfigRecord) => void
}

export function RemoveHostAgentDialog({ record, onCancel, onConfirm }: RemoveHostAgentDialogProps) {
  const t = useTranslations("mobile.externalAgents")
  const name = record ? hostAgentName(record) : ""
  return (
    <AlertDialog
      open={record !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("deleteConfirmTitle", { name })}</AlertDialogTitle>
          <AlertDialogDescription>{t("deleteConfirmBody", { name })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="h-11">{t("deleteCancel")}</AlertDialogCancel>
          <AlertDialogAction
            className="h-11"
            onClick={() => {
              if (record) onConfirm(record)
            }}
            aria-label={t("removeAria", { name })}
            data-testid="host-agent-remove-confirm"
          >
            {t("deleteConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
