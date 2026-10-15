"use client"

import { useTranslations } from "next-intl"

import { PresetPickerList } from "@/components/agent/external-agent/add-agent/preset-picker-list"
import { ResponsiveFormDialog } from "@/components/shared/responsive-form-dialog"

export interface AddAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (presetId: string) => void
  disabled?: boolean
}

export function AddAgentDialog({ open, onOpenChange, onPick, disabled }: AddAgentDialogProps) {
  const t = useTranslations("externalAgent.settings")
  const tPicker = useTranslations("externalAgent.picker")

  return (
    <ResponsiveFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("addAgent")}
      description={tPicker("description")}
      testid="add-agent"
    >
      <PresetPickerList
        disabled={disabled}
        autoFocusSearch
        onPick={(presetId) => {
          onOpenChange(false)
          onPick(presetId)
        }}
      />
    </ResponsiveFormDialog>
  )
}
