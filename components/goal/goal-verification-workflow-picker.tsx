"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { listGoalVerifierWorkflowOptions } from "@/lib/goal/verification"
import type { WorkflowDependencyBinding } from "@/types/workflow/deployment"

const NONE = "__none__"

export function GoalVerificationWorkflowPicker({
  value,
  disabled,
  onChange,
}: {
  value?: WorkflowDependencyBinding
  disabled?: boolean
  onChange: (binding: WorkflowDependencyBinding | undefined) => void
}) {
  const t = useTranslations("goal.config.verification")
  const options = useLiveQuery(() => listGoalVerifierWorkflowOptions(), [], [])

  return (
    <Select
      value={value?.versionId ?? NONE}
      disabled={disabled}
      onValueChange={(versionId) => {
        onChange(
          versionId === NONE
            ? undefined
            : options.find((option) => option.binding.versionId === versionId)?.binding
        )
      }}
    >
      <SelectTrigger aria-label={t("label")} data-testid="goal-verification-workflow">
        <SelectValue placeholder={t("placeholder")} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{t("disabled")}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.binding.versionId} value={option.binding.versionId}>
            {option.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
