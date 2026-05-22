"use client"

/**
 * Workspace settings → Overview section.
 *
 * Original General + Execution + Toggles cards extracted verbatim from
 * `workspace/settings.tsx`. Pure presentation — the parent owns local state
 * and the save handler. Kept as a single file so the accordion composer can
 * mount it without touching any of the historical card layout (per the
 * [[feedback_reuse_existing_components]] rule: the existing 3-card surface
 * is preserved bit-for-bit; only the wrapping changed).
 */

import type { Dispatch, SetStateAction } from "react"
import { useTranslations } from "next-intl"

import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { AgentTeam } from "@/types/agent/agent-team"

const EXECUTION_MODES: ReadonlyArray<{ value: string; labelKey: string }> = [
  { value: "coordinated", labelKey: "coordinated" },
  { value: "autonomous", labelKey: "autonomous" },
  { value: "delegate", labelKey: "delegate" },
]

const EXECUTION_PATTERNS: ReadonlyArray<{ value: string; labelKey: string }> = [
  { value: "manager_worker", labelKey: "managerWorker" },
  { value: "parallel_specialists", labelKey: "parallelSpecialists" },
  { value: "background_handoff", labelKey: "backgroundHandoff" },
  { value: "external_handoff", labelKey: "externalHandoff" },
  { value: "single_agent_recommended", labelKey: "singleAgent" },
]

export interface OverviewSectionProps {
  team: AgentTeam
  name: string
  setName: Dispatch<SetStateAction<string>>
  description: string
  setDescription: Dispatch<SetStateAction<string>>
  executionMode: string
  setExecutionMode: Dispatch<SetStateAction<string>>
  executionPattern: string
  setExecutionPattern: Dispatch<SetStateAction<string>>
  maxConcurrent: string
  setMaxConcurrent: Dispatch<SetStateAction<string>>
  tokenBudget: string
  setTokenBudget: Dispatch<SetStateAction<string>>
  autoShutdown: boolean
  setAutoShutdown: Dispatch<SetStateAction<boolean>>
  enableMessaging: boolean
  setEnableMessaging: Dispatch<SetStateAction<boolean>>
  requirePlanApproval: boolean
  setRequirePlanApproval: Dispatch<SetStateAction<boolean>>
  maxRetries: string
  setMaxRetries: Dispatch<SetStateAction<string>>
}

export function OverviewSection(props: OverviewSectionProps) {
  const t = useTranslations("agentTeamsWorkspace.settings")
  const tMode = useTranslations("agentTeamsWorkspace.settings.executionModeOption")
  const tPattern = useTranslations("agentTeamsWorkspace.settings.executionPatternOption")
  return (
    <div className="space-y-4">
      {/* General */}
      <Card className="space-y-3 p-4">
        <p className="text-sm font-medium">{t("title")}</p>
        <div className="space-y-1">
          <Label className="text-xs">{t("name")}</Label>
          <Input
            value={props.name}
            onChange={(e) => props.setName(e.target.value)}
            className="max-w-md"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("description")}</Label>
          <Textarea
            rows={3}
            value={props.description}
            onChange={(e) => props.setDescription(e.target.value)}
            className="max-w-2xl text-xs"
          />
        </div>
      </Card>

      {/* Execution */}
      <Card className="space-y-3 p-4">
        <p className="text-sm font-medium">{t("sectionExecution")}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">{t("executionMode")}</Label>
            <Select value={props.executionMode} onValueChange={(v) => props.setExecutionMode(v)}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXECUTION_MODES.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {tMode(m.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("executionPattern")}</Label>
            <Select
              value={props.executionPattern}
              onValueChange={(v) => props.setExecutionPattern(v)}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXECUTION_PATTERNS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {tPattern(p.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">{t("maxConcurrent")}</Label>
            <Input
              type="number"
              min={1}
              max={20}
              value={props.maxConcurrent}
              onChange={(e) => props.setMaxConcurrent(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("tokenBudget")}</Label>
            <Input
              type="number"
              min={0}
              value={props.tokenBudget}
              onChange={(e) => props.setTokenBudget(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
        </div>
      </Card>

      {/* Toggles */}
      <Card className="space-y-3 p-4">
        <p className="text-sm font-medium">{t("sectionControls")}</p>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-xs">{t("autoShutdown")}</Label>
            <Switch checked={props.autoShutdown} onCheckedChange={props.setAutoShutdown} />
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-xs">{t("enableMessaging")}</Label>
            <Switch checked={props.enableMessaging} onCheckedChange={props.setEnableMessaging} />
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-xs">{t("requirePlanApproval")}</Label>
            <Switch
              checked={props.requirePlanApproval}
              onCheckedChange={props.setRequirePlanApproval}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("maxRetries")}</Label>
            <Input
              type="number"
              min={0}
              max={10}
              value={props.maxRetries}
              onChange={(e) => props.setMaxRetries(e.target.value)}
              className="h-8 w-24 text-xs"
            />
          </div>
        </div>
      </Card>
    </div>
  )
}
