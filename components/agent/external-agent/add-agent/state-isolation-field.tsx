"use client"

/**
 * Where an external agent keeps its runtime state: its own private home, or the
 * runtime's shared default one (ADR-0216).
 *
 * Shared by every surface that creates or edits a configuration (the phone's
 * add and detail screens, the desktop editor), so the choice reads the same
 * everywhere and the rule for when "own state" is impossible lives in one
 * place: a runtime with no documented home variable
 * (`agentStateIsolationFor` in `protocol/external-agent-security-policy.json`)
 * cannot be isolated, so that choice is disabled with the reason, never
 * offered and then refused at launch.
 */

import { useId } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, InfoIcon } from "lucide-react"

import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { agentStateIsolationFor } from "@/lib/ai/agent/external/policy/security-policy"
import { cn } from "@/lib/utils"
import type { ExternalAgentStateIsolation } from "@/types/agent/external-agent"

/** Whether a launch target can be given its own state root. */
export function stateIsolationSupported(
  command: string | undefined,
  args: readonly string[] = []
): boolean {
  const trimmed = command?.trim()
  return Boolean(trimmed) && agentStateIsolationFor(trimmed!, args) !== null
}

/**
 * The isolation a new configuration starts with: its own state (ADR-0216)
 * where the runtime can have one, the shared state where it cannot. An agent
 * with no local command (a network agent) has nothing to isolate and takes the
 * new-configuration default, which changes nothing at launch.
 */
export function defaultStateIsolationFor(
  command: string | undefined,
  args: readonly string[] = []
): ExternalAgentStateIsolation {
  if (!command?.trim()) return "isolated"
  return stateIsolationSupported(command, args) ? "isolated" : "shared"
}

/**
 * The isolation to store for a choice: the one asked for, or the default when
 * nothing was asked, but never `isolated` on a runtime that cannot be isolated
 * (the launch would only be refused). A form keeps the user's raw choice and
 * stores this, so editing the command back to an isolatable runtime restores
 * what the user picked.
 */
export function effectiveStateIsolation(
  requested: ExternalAgentStateIsolation | undefined,
  command: string | undefined,
  args: readonly string[] = []
): ExternalAgentStateIsolation {
  if (requested === "isolated" && command?.trim() && !stateIsolationSupported(command, args)) {
    return "shared"
  }
  return requested ?? defaultStateIsolationFor(command, args)
}

export interface StateIsolationFieldProps {
  value: ExternalAgentStateIsolation
  onChange: (value: ExternalAgentStateIsolation) => void
  /** The launch command. Absent or empty: the agent runs elsewhere. */
  command?: string
  args?: readonly string[]
  disabled?: boolean
  /**
   * Say that choosing "own state" starts the agent signed out. Set by an
   * editor when the saved configuration currently uses the shared state, so
   * moving it is a change the user should hear about before saving.
   */
  showSignInWarning?: boolean
  className?: string
}

export function StateIsolationField({
  value,
  onChange,
  command,
  args = [],
  disabled = false,
  showSignInWarning = false,
  className,
}: StateIsolationFieldProps) {
  const t = useTranslations("externalAgent.stateIsolationField")
  const baseId = useId()
  const hasCommand = Boolean(command?.trim())
  const supported = stateIsolationSupported(command, args)
  const isolatedDisabled = disabled || (hasCommand && !supported)

  const options: Array<{
    value: ExternalAgentStateIsolation
    label: string
    hint: string
    disabled: boolean
  }> = [
    {
      value: "isolated",
      label: t("isolatedLabel"),
      hint: t("isolatedHint"),
      disabled: isolatedDisabled,
    },
    { value: "shared", label: t("sharedLabel"), hint: t("sharedHint"), disabled },
  ]

  return (
    <fieldset className={cn("grid gap-2", className)} data-testid="state-isolation-field">
      <legend className="mb-1 text-sm font-medium">{t("legend")}</legend>
      <RadioGroup
        value={value}
        onValueChange={(next) => onChange(next as ExternalAgentStateIsolation)}
        disabled={disabled}
        className="gap-2"
        aria-label={t("legend")}
      >
        {options.map((option) => {
          const id = `${baseId}-${option.value}`
          return (
            <Label
              key={option.value}
              htmlFor={id}
              className={cn(
                "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal",
                value === option.value && "border-primary bg-primary/5",
                option.disabled && "cursor-not-allowed opacity-60"
              )}
            >
              <RadioGroupItem
                id={id}
                value={option.value}
                disabled={option.disabled}
                className="mt-0.5"
                data-testid={`state-isolation-${option.value}`}
              />
              <span className="grid min-w-0 gap-0.5">
                <span className="text-sm font-medium">{option.label}</span>
                <span className="text-xs text-muted-foreground">{option.hint}</span>
              </span>
            </Label>
          )
        })}
      </RadioGroup>
      {!hasCommand ? (
        <p
          className="flex items-start gap-1.5 text-xs text-muted-foreground"
          data-testid="state-isolation-not-applicable"
        >
          <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("notApplicable")}
        </p>
      ) : !supported ? (
        <p
          className="flex items-start gap-1.5 text-xs text-muted-foreground"
          data-testid="state-isolation-unsupported"
        >
          <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("unsupported", { command: command!.trim() })}
        </p>
      ) : null}
      {showSignInWarning && value === "isolated" && supported ? (
        <p
          role="status"
          className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          data-testid="state-isolation-sign-in-warning"
        >
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("signInWarning")}
        </p>
      ) : null}
    </fieldset>
  )
}
