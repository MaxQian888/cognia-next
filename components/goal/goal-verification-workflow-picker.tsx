"use client"

/**
 * The completion-verifier workflow a goal binds. Its options are the
 * catalog of the device the goal runs on (`useGoalVerifierOptions`): this
 * database on the desktop, the paired desktop's over the companion on a phone.
 */

import { useTranslations } from "next-intl"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useGoalVerifierOptions } from "@/hooks/goal/use-goal-verifier-options"
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
  const { options, failed } = useGoalVerifierOptions()

  return (
    <>
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
      {failed ? (
        <p
          className="mt-1 text-xs text-destructive"
          role="alert"
          data-testid="goal-verification-options-failed"
        >
          {t("optionsFailed")}
        </p>
      ) : null}
    </>
  )
}
