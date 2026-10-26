"use client"

/**
 * Hand the organization to another member.
 *
 * # Why not the org-role select
 *
 * The roster's org-role select can already make someone an owner, but stepping
 * the current owner down is then a second write. Between the two the org has
 * two owners, and if the second fails it keeps both; done the other way round
 * the last-owner guard refuses the first step outright. The server's transfer
 * route does both in one transaction, so this dialog uses it and asks the one
 * question that route needs: what the current owner becomes.
 */

import { useState } from "react"
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
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

import type { OrgRole } from "@/types/identity"

export type PreviousOwnerRole = Exclude<OrgRole, "owner">

const STEP_DOWN_ROLES: readonly PreviousOwnerRole[] = ["admin", "member"]

export interface TransferOwnershipDialogProps {
  /** The member who would become owner; `null` closes the dialog. */
  target: { userId: string; name: string } | null
  busy: boolean
  onCancel: () => void
  onConfirm: (input: { toUserId: string; previousOwnerRole: PreviousOwnerRole }) => void
}

export function TransferOwnershipDialog({
  target,
  busy,
  onCancel,
  onConfirm,
}: TransferOwnershipDialogProps) {
  const t = useTranslations("workspace.members.transfer")
  const tCommon = useTranslations("common")
  const tOrgRole = useTranslations("workspace.members.orgRole")
  // Admin by default: stepping down to plain member also gives up the
  // management the outgoing owner most often still needs during a handover.
  const [stepDownTo, setStepDownTo] = useState<PreviousOwnerRole>("admin")

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <AlertDialogContent data-testid="workspace-transfer-ownership">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title", { name: target?.name ?? "" })}</AlertDialogTitle>
          <AlertDialogDescription>{t("body")}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="workspace-transfer-step-down">{t("stepDownLabel")}</Label>
          <Select
            value={stepDownTo}
            onValueChange={(value) => setStepDownTo(value as PreviousOwnerRole)}
          >
            <SelectTrigger
              id="workspace-transfer-step-down"
              className="w-40"
              data-testid="workspace-transfer-step-down"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STEP_DOWN_ROLES.map((role) => (
                <SelectItem key={role} value={role}>
                  {tOrgRole(role)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy || !target}
            data-testid="workspace-transfer-confirm"
            onClick={() => {
              if (target) onConfirm({ toUserId: target.userId, previousOwnerRole: stepDownTo })
            }}
          >
            {t("confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
