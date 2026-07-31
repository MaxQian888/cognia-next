"use client"

/**
 * Collapsible "advanced options" panel for the auto-compose dialog.
 *
 * Minimal by default (closed): the operator can open it to set the team-size
 * cap, force an execution pattern instead of the routing-assessed one, toggle
 * run options (require plan approval, ultracode), and turn the AI
 * goal-clarification step on/off. Purely controlled — it owns no state beyond
 * the open/closed disclosure.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, Settings2Icon } from "lucide-react"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import type { TeamExecutionPattern } from "@/types/agent/agent-team"

/** Hard bounds for the team-size control (incl. the lead). */
export const MIN_AUTO_ROSTER = 2
export const MAX_AUTO_ROSTER = 10

/** "auto" lets the routing assessment pick; otherwise the operator forces one. */
export type PatternChoice = TeamExecutionPattern | "auto"

const PATTERNS: readonly TeamExecutionPattern[] = [
  "manager_worker",
  "parallel_specialists",
  "background_handoff",
  "external_handoff",
  "single_agent_recommended",
  "ultracode_orchestration",
]

export interface AutoComposeOptions {
  maxRoster: number
  preferredPattern: PatternChoice
  requirePlanApproval: boolean
  ultracode: boolean
  clarifyEnabled: boolean
  /** Opt into a council executor (cross-model consensus on one answer). */
  consensusNeeded: boolean
  /** Opt into a verification ensemble (N samples + synthesis). */
  verificationNeeded: boolean
}

export const DEFAULT_AUTO_COMPOSE_OPTIONS: AutoComposeOptions = {
  maxRoster: 6,
  preferredPattern: "auto",
  requirePlanApproval: false,
  ultracode: false,
  clarifyEnabled: true,
  consensusNeeded: false,
  verificationNeeded: false,
}

export interface AutoComposeAdvancedOptionsProps {
  options: AutoComposeOptions
  onChange: (next: AutoComposeOptions) => void
  disabled?: boolean
}

export function AutoComposeAdvancedOptions({
  options,
  onChange,
  disabled,
}: AutoComposeAdvancedOptionsProps) {
  const t = useTranslations("agentTeamsWorkspace.autoCompose")
  const [open, setOpen] = useState(false)

  const patch = (next: Partial<AutoComposeOptions>) => onChange({ ...options, ...next })

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
          data-testid="auto-compose-advanced-trigger"
        >
          <Settings2Icon className="size-3.5" />
          {t("advanced")}
          <ChevronDownIcon
            className={cn("ml-auto size-3.5 transition-transform", open && "rotate-180")}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 rounded-md border border-t-0 p-3 pt-3">
        {/* Team size */}
        <div className="space-y-2">
          <Label className="text-xs">{t("maxRosterLabel", { count: options.maxRoster })}</Label>
          <Slider
            min={MIN_AUTO_ROSTER}
            max={MAX_AUTO_ROSTER}
            step={1}
            value={[options.maxRoster]}
            onValueChange={([v]) => patch({ maxRoster: v })}
            disabled={disabled}
            data-testid="auto-compose-max-roster"
            aria-label={t("maxRosterLabel", { count: options.maxRoster })}
          />
        </div>

        {/* Execution pattern */}
        <div className="space-y-1.5">
          <Label className="text-xs">{t("patternLabel")}</Label>
          <Select
            value={options.preferredPattern}
            onValueChange={(v) => patch({ preferredPattern: v as PatternChoice })}
            disabled={disabled}
          >
            <SelectTrigger size="sm" className="text-xs" data-testid="auto-compose-pattern">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t("patternAuto")}</SelectItem>
              {PATTERNS.map((p) => (
                <SelectItem key={p} value={p}>
                  {t(`patterns.${p}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Run options */}
        <OptionSwitch
          label={t("requirePlanApproval")}
          checked={options.requirePlanApproval}
          disabled={disabled}
          testId="auto-compose-require-approval"
          onCheckedChange={(v) => patch({ requirePlanApproval: v })}
        />
        <OptionSwitch
          label={t("ultracode")}
          checked={options.ultracode}
          disabled={disabled}
          testId="auto-compose-ultracode"
          onCheckedChange={(v) => patch({ ultracode: v })}
        />
        <OptionSwitch
          label={t("clarifyToggle")}
          checked={options.clarifyEnabled}
          disabled={disabled}
          testId="auto-compose-clarify-toggle"
          onCheckedChange={(v) => patch({ clarifyEnabled: v })}
        />
        <OptionSwitch
          label={t("consensusOption")}
          checked={options.consensusNeeded}
          disabled={disabled}
          testId="auto-compose-consensus"
          onCheckedChange={(v) =>
            patch({ consensusNeeded: v, ...(v ? { verificationNeeded: false } : {}) })
          }
        />
        <OptionSwitch
          label={t("verifyOption")}
          checked={options.verificationNeeded}
          disabled={disabled}
          testId="auto-compose-verify"
          onCheckedChange={(v) =>
            patch({ verificationNeeded: v, ...(v ? { consensusNeeded: false } : {}) })
          }
        />
      </CollapsibleContent>
    </Collapsible>
  )
}

interface OptionSwitchProps {
  label: string
  checked: boolean
  disabled?: boolean
  testId: string
  onCheckedChange: (v: boolean) => void
}

function OptionSwitch({ label, checked, disabled, testId, onCheckedChange }: OptionSwitchProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Label className="text-xs font-normal">{label}</Label>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        data-testid={testId}
        aria-label={label}
      />
    </div>
  )
}
