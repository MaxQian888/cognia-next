"use client"

/**
 * Per-kind inspector config forms. Co-located in one file because each form
 * is small (5–20 lines of fields) and they all share the same shape — the
 * registry imports them as named exports.
 *
 * Forms intentionally do NOT validate at the field level; the orchestrator
 * runs the kind's zod schema (Phase 6) on save. Field-level errors land in
 * Phase 9 polish.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Plus, Trash2 } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Field, FieldGroup, readBoolean, readNumber, readString, patchParam } from "./shared"
import { ExpressionField } from "./shared/expression-field"
import { ConditionBuilder } from "./shared/condition-builder"
import type { WorkflowConditionGroup } from "@/types/workflow/conditions"
import { useInspectorExpressionCtx } from "./shared/inspector-context"
import { getWebhookUrl } from "@/lib/workflow/runtime/webhook-bridge"
import { listAdapterInstances } from "@/lib/db/adapter-instances"
import {
  CharacterPicker,
  TeamPicker,
  SkillPicker,
  McpServerPicker,
  McpToolPicker,
  PluginPicker,
  SubworkflowPicker,
  TwinPicker,
  EntityPicker,
} from "./shared/entity-picker"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import type { PluginCapabilities } from "@/lib/plugin/api/plugin-capability-registry"
import { CronBuilder } from "./shared/cron-builder"
import { DurationField } from "./shared/duration-field"

type Params = Record<string, unknown>
type ChangeFn = (next: Params) => void

interface ConfigProps {
  params: Params
  onChange: ChangeFn
  /**
   * The node's `typeVersion` — forms with a structured v2 params generation
   * (branch/switch) dispatch on it. Omitted by callers that predate the
   * field; treated as 1 (legacy shape).
   */
  typeVersion?: number
}

function parseObjectJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function parseArrayJson(raw: string): unknown[] | null {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function clampNumberInput(raw: string, min: number, max: number, fallback: number): number {
  const parsed = Math.floor(Number(raw))
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

// ── trigger.manual ────────────────────────────────────────────────────────
export function ManualTriggerConfig() {
  const t = useTranslations("workflows.forms.manualTrigger")
  return <p className="text-xs text-muted-foreground">{t("intro")}</p>
}

// ── trigger.cron ──────────────────────────────────────────────────────────
export function CronConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.cron")
  const cron = readString(params, "cron", "0 9 * * 1-5")
  const tz = readString(params, "timezone", "")
  return (
    <FieldGroup>
      <Field
        label={t("cronExpression.label")}
        htmlFor="cron-expr"
        hint={t("cronExpression.hint")}
        name="cron"
        required
      >
        <CronBuilder
          id="cron-expr"
          value={cron}
          onChange={(next) => onChange(patchParam(params, "cron", next))}
          timezone={tz || undefined}
        />
      </Field>
      <Field
        label={t("timezone.label")}
        htmlFor="cron-tz"
        hint={t("timezone.hint")}
        name="timezone"
      >
        <Input
          id="cron-tz"
          value={tz}
          onChange={(e) => onChange(patchParam(params, "timezone", e.target.value))}
          placeholder={t("timezone.placeholder")}
        />
      </Field>
    </FieldGroup>
  )
}

// ── trigger.connector.inbound ─────────────────────────────────────────────
export function ConnectorInboundConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.connectorInbound")
  const adapterId = readString(params, "adapterId")
  const conversationKey = readString(params, "conversationKey")
  const characterId = readString(params, "characterId")
  return (
    <FieldGroup>
      <Field
        label={t("adapter.label")}
        htmlFor="ci-adapter"
        hint={t("adapter.hint")}
        name="adapterId"
        required
      >
        <Input
          id="ci-adapter"
          value={adapterId}
          onChange={(e) => onChange(patchParam(params, "adapterId", e.target.value))}
          placeholder={t("adapter.placeholder")}
        />
      </Field>
      <Field
        label={t("conversationKey.label")}
        htmlFor="ci-conv"
        hint={t("conversationKey.hint")}
        name="conversationKey"
      >
        <Input
          id="ci-conv"
          value={conversationKey}
          onChange={(e) => onChange(patchParam(params, "conversationKey", e.target.value))}
        />
      </Field>
      <Field label={t("characterId.label")} htmlFor="ci-char" name="characterId">
        <CharacterPicker
          id="ci-char"
          value={characterId}
          onChange={(v) => onChange(patchParam(params, "characterId", v))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── trigger.chat.message ──────────────────────────────────────────────────
export function ChatMessageTriggerConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.chatMessageTrigger")
  const characterId = readString(params, "characterId")
  const sessionId = readString(params, "sessionId")
  return (
    <FieldGroup>
      <Field label={t("character.label")} htmlFor="cm-char" name="characterId" required>
        <CharacterPicker
          id="cm-char"
          value={characterId}
          onChange={(v) => onChange(patchParam(params, "characterId", v))}
        />
      </Field>
      <Field
        label={t("sessionId.label")}
        htmlFor="cm-session"
        hint={t("sessionId.hint")}
        name="sessionId"
      >
        <Input
          id="cm-session"
          value={sessionId}
          onChange={(e) => onChange(patchParam(params, "sessionId", e.target.value))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── trigger.goal.completed ────────────────────────────────────────────────
export function GoalCompletedTriggerConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.goalCompletedTrigger")
  const goalId = readString(params, "goalId")
  const sessionId = readString(params, "sessionId")
  const characterId = readString(params, "characterId")
  const status = readString(params, "status")
  return (
    <FieldGroup>
      <Field label={t("goalId.label")} htmlFor="gc-goal" hint={t("goalId.hint")} name="goalId">
        <Input
          id="gc-goal"
          value={goalId}
          onChange={(e) => onChange(patchParam(params, "goalId", e.target.value))}
        />
      </Field>
      <Field label={t("status.label")} htmlFor="gc-status" hint={t("status.hint")} name="status">
        <Input
          id="gc-status"
          value={status}
          onChange={(e) => onChange(patchParam(params, "status", e.target.value))}
          placeholder={t("status.placeholder")}
        />
      </Field>
      <Field
        label={t("sessionId.label")}
        htmlFor="gc-session"
        hint={t("sessionId.hint")}
        name="sessionId"
      >
        <Input
          id="gc-session"
          value={sessionId}
          onChange={(e) => onChange(patchParam(params, "sessionId", e.target.value))}
        />
      </Field>
      <Field label={t("characterId.label")} htmlFor="gc-char" name="characterId">
        <CharacterPicker
          id="gc-char"
          value={characterId}
          onChange={(v) => onChange(patchParam(params, "characterId", v))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.goal.* ─────────────────────────────────────────────────────────
export function GoalCreateConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.goalCreate")
  const sessionId = readString(params, "sessionId")
  const rawObjective = readString(params, "rawObjective")
  const characterId = readString(params, "characterId")
  const startPaused = readBoolean(params, "startPaused")
  const configJson = readString(params, "configJson")
  return (
    <FieldGroup>
      <Field
        label={t("sessionId.label")}
        htmlFor="goal-create-session"
        hint={t("sessionId.hint")}
        name="sessionId"
        required
      >
        <Input
          id="goal-create-session"
          value={sessionId}
          onChange={(e) => onChange(patchParam(params, "sessionId", e.target.value))}
          placeholder={t("sessionId.placeholder")}
        />
      </Field>
      <Field
        label={t("rawObjective.label")}
        htmlFor="goal-create-objective"
        hint={t("rawObjective.hint")}
        name="rawObjective"
        required
      >
        <Textarea
          id="goal-create-objective"
          value={rawObjective}
          onChange={(e) => onChange(patchParam(params, "rawObjective", e.target.value))}
          placeholder={t("rawObjective.placeholder")}
          rows={3}
        />
      </Field>
      <Field label={t("characterId.label")} htmlFor="goal-create-character" name="characterId">
        <CharacterPicker
          id="goal-create-character"
          value={characterId}
          onChange={(v) => onChange(patchParam(params, "characterId", v))}
        />
      </Field>
      <Field
        label={t("startPaused.label")}
        htmlFor="goal-create-start-paused"
        hint={t("startPaused.hint")}
        name="startPaused"
      >
        <Switch
          id="goal-create-start-paused"
          checked={startPaused}
          onCheckedChange={(v) => onChange(patchParam(params, "startPaused", v))}
        />
      </Field>
      <Field
        label={t("configJson.label")}
        htmlFor="goal-create-config"
        hint={t("configJson.hint")}
        name="configJson"
      >
        <Textarea
          id="goal-create-config"
          value={configJson}
          onChange={(e) => {
            const next = patchParam(params, "configJson", e.target.value) as Record<string, unknown>
            const parsed = parseObjectJson(e.target.value)
            if (parsed) next.config = parsed
            onChange(next)
          }}
          rows={4}
          className="font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  )
}

export function GoalListConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.goalList")
  const mode = readString(params, "mode", "all")
  const sessionId = readString(params, "sessionId")
  const limit = readNumber(params, "limit", 500)
  return (
    <FieldGroup>
      <Field label={t("mode.label")} htmlFor="goal-list-mode" name="mode">
        <Select value={mode} onValueChange={(v) => onChange(patchParam(params, "mode", v))}>
          <SelectTrigger id="goal-list-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("mode.options.all")}</SelectItem>
            <SelectItem value="session">{t("mode.options.session")}</SelectItem>
            <SelectItem value="activeForSession">{t("mode.options.activeForSession")}</SelectItem>
            <SelectItem value="openForSession">{t("mode.options.openForSession")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("sessionId.label")}
        htmlFor="goal-list-session"
        hint={t("sessionId.hint")}
        name="sessionId"
      >
        <Input
          id="goal-list-session"
          value={sessionId}
          onChange={(e) => onChange(patchParam(params, "sessionId", e.target.value))}
        />
      </Field>
      <Field label={t("limit.label")} htmlFor="goal-list-limit" hint={t("limit.hint")} name="limit">
        <Input
          id="goal-list-limit"
          type="number"
          min={1}
          max={1000}
          value={limit}
          onChange={(e) =>
            onChange(patchParam(params, "limit", clampNumberInput(e.target.value, 1, 1000, 500)))
          }
        />
      </Field>
    </FieldGroup>
  )
}

export function GoalTransitionConfig({ params, onChange }: ConfigProps & { intent?: string }) {
  const t = useTranslations("workflows.forms.goalCommon")
  const goalId = readString(params, "goalId")
  return (
    <FieldGroup>
      <Field
        label={t("goalId.label")}
        htmlFor="goal-transition-id"
        hint={t("goalId.hint")}
        name="goalId"
        required
      >
        <Input
          id="goal-transition-id"
          value={goalId}
          onChange={(e) => onChange(patchParam(params, "goalId", e.target.value))}
          placeholder={t("goalId.placeholder")}
        />
      </Field>
    </FieldGroup>
  )
}

export function GoalEventsConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.goalEvents")
  const limit = readNumber(params, "limit", 200)
  return (
    <FieldGroup>
      <GoalTransitionConfig params={params} onChange={onChange} />
      <Field
        label={t("limit.label")}
        htmlFor="goal-events-limit"
        hint={t("limit.hint")}
        name="limit"
      >
        <Input
          id="goal-events-limit"
          type="number"
          min={1}
          max={5000}
          value={limit}
          onChange={(e) =>
            onChange(patchParam(params, "limit", clampNumberInput(e.target.value, 1, 5000, 200)))
          }
        />
      </Field>
    </FieldGroup>
  )
}

export function GoalUpdateObjectiveConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.goalUpdateObjective")
  const rawObjective = readString(params, "rawObjective")
  return (
    <FieldGroup>
      <GoalTransitionConfig params={params} onChange={onChange} />
      <Field
        label={t("rawObjective.label")}
        htmlFor="goal-update-objective"
        hint={t("rawObjective.hint")}
        name="rawObjective"
        required
      >
        <Textarea
          id="goal-update-objective"
          value={rawObjective}
          onChange={(e) => onChange(patchParam(params, "rawObjective", e.target.value))}
          rows={3}
        />
      </Field>
    </FieldGroup>
  )
}

export function GoalUpdateConfigConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.goalUpdateConfig")
  const configJson = readString(params, "configJson")
  return (
    <FieldGroup>
      <GoalTransitionConfig params={params} onChange={onChange} />
      <Field
        label={t("configJson.label")}
        htmlFor="goal-update-config"
        hint={t("configJson.hint")}
        name="configJson"
        required
      >
        <Textarea
          id="goal-update-config"
          value={configJson}
          onChange={(e) => {
            const next = patchParam(params, "configJson", e.target.value) as Record<string, unknown>
            const parsed = parseObjectJson(e.target.value)
            if (parsed) next.config = parsed
            onChange(next)
          }}
          rows={4}
          className="font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  )
}

export function GoalToggleSubgoalConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.goalToggleSubgoal")
  const subgoalId = readString(params, "subgoalId")
  return (
    <FieldGroup>
      <GoalTransitionConfig params={params} onChange={onChange} />
      <Field
        label={t("subgoalId.label")}
        htmlFor="goal-toggle-subgoal"
        hint={t("subgoalId.hint")}
        name="subgoalId"
        required
      >
        <Input
          id="goal-toggle-subgoal"
          value={subgoalId}
          onChange={(e) => onChange(patchParam(params, "subgoalId", e.target.value))}
          placeholder={t("subgoalId.placeholder")}
        />
      </Field>
    </FieldGroup>
  )
}

export function GoalAnalyticsConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.goalAnalytics")
  const scope = readString(params, "scope", "all")
  const sessionId = readString(params, "sessionId")
  const limit = readNumber(params, "limit", 500)
  const windowDays = readNumber(params, "windowDays", 30)
  return (
    <FieldGroup>
      <Field label={t("scope.label")} htmlFor="goal-analytics-scope" name="scope">
        <Select value={scope} onValueChange={(v) => onChange(patchParam(params, "scope", v))}>
          <SelectTrigger id="goal-analytics-scope">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("scope.options.all")}</SelectItem>
            <SelectItem value="session">{t("scope.options.session")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("sessionId.label")}
        htmlFor="goal-analytics-session"
        hint={t("sessionId.hint")}
        name="sessionId"
      >
        <Input
          id="goal-analytics-session"
          value={sessionId}
          onChange={(e) => onChange(patchParam(params, "sessionId", e.target.value))}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label={t("limit.label")}
          htmlFor="goal-analytics-limit"
          hint={t("limit.hint")}
          name="limit"
        >
          <Input
            id="goal-analytics-limit"
            type="number"
            min={1}
            max={1000}
            value={limit}
            onChange={(e) =>
              onChange(patchParam(params, "limit", clampNumberInput(e.target.value, 1, 1000, 500)))
            }
          />
        </Field>
        <Field
          label={t("windowDays.label")}
          htmlFor="goal-analytics-window"
          hint={t("windowDays.hint")}
          name="windowDays"
        >
          <Input
            id="goal-analytics-window"
            type="number"
            min={1}
            max={366}
            value={windowDays}
            onChange={(e) =>
              onChange(
                patchParam(params, "windowDays", clampNumberInput(e.target.value, 1, 366, 30))
              )
            }
          />
        </Field>
      </div>
    </FieldGroup>
  )
}

function GoalTemplateIdField({
  params,
  onChange,
  id,
}: {
  params: Params
  onChange: ChangeFn
  id: string
}) {
  const t = useTranslations("workflows.forms.goalTemplateCommon")
  return (
    <Field
      label={t("templateId.label")}
      htmlFor={id}
      hint={t("templateId.hint")}
      name="templateId"
      required
    >
      <Input
        id={id}
        value={readString(params, "templateId")}
        onChange={(e) => onChange(patchParam(params, "templateId", e.target.value))}
        placeholder={t("templateId.placeholder")}
      />
    </Field>
  )
}

export function GoalTemplateListConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.goalTemplateList")
  const includeBuiltIn = readBoolean(params, "includeBuiltIn", true)
  const favoriteOnly = readBoolean(params, "favoriteOnly")
  const limit = readNumber(params, "limit", 500)
  return (
    <FieldGroup>
      <Field
        label={t("includeBuiltIn.label")}
        htmlFor="goal-template-list-builtins"
        hint={t("includeBuiltIn.hint")}
        name="includeBuiltIn"
      >
        <Switch
          id="goal-template-list-builtins"
          checked={includeBuiltIn}
          onCheckedChange={(v) => onChange(patchParam(params, "includeBuiltIn", v))}
        />
      </Field>
      <Field
        label={t("favoriteOnly.label")}
        htmlFor="goal-template-list-favorites"
        hint={t("favoriteOnly.hint")}
        name="favoriteOnly"
      >
        <Switch
          id="goal-template-list-favorites"
          checked={favoriteOnly}
          onCheckedChange={(v) => onChange(patchParam(params, "favoriteOnly", v))}
        />
      </Field>
      <Field
        label={t("query.label")}
        htmlFor="goal-template-list-query"
        hint={t("query.hint")}
        name="query"
      >
        <Input
          id="goal-template-list-query"
          value={readString(params, "query")}
          onChange={(e) => onChange(patchParam(params, "query", e.target.value))}
          placeholder={t("query.placeholder")}
        />
      </Field>
      <Field
        label={t("limit.label")}
        htmlFor="goal-template-list-limit"
        hint={t("limit.hint")}
        name="limit"
      >
        <Input
          id="goal-template-list-limit"
          type="number"
          min={1}
          max={1000}
          value={limit}
          onChange={(e) =>
            onChange(patchParam(params, "limit", clampNumberInput(e.target.value, 1, 1000, 500)))
          }
        />
      </Field>
    </FieldGroup>
  )
}

export function GoalTemplateCreateGoalConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.goalTemplateCreateGoal")
  return (
    <FieldGroup>
      <GoalTemplateIdField params={params} onChange={onChange} id="goal-template-create-id" />
      <Field
        label={t("sessionId.label")}
        htmlFor="goal-template-create-session"
        hint={t("sessionId.hint")}
        name="sessionId"
        required
      >
        <Input
          id="goal-template-create-session"
          value={readString(params, "sessionId")}
          onChange={(e) => onChange(patchParam(params, "sessionId", e.target.value))}
          placeholder={t("sessionId.placeholder")}
        />
      </Field>
      <Field
        label={t("characterId.label")}
        htmlFor="goal-template-create-character"
        name="characterId"
      >
        <CharacterPicker
          id="goal-template-create-character"
          value={readString(params, "characterId")}
          onChange={(v) => onChange(patchParam(params, "characterId", v))}
        />
      </Field>
    </FieldGroup>
  )
}

export function GoalTemplateUpsertConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.goalTemplateUpsert")
  const sortOrder = readNumber(params, "sortOrder", 0)
  return (
    <FieldGroup>
      <GoalTemplateIdField params={params} onChange={onChange} id="goal-template-upsert-id" />
      <Field
        label={t("title.label")}
        htmlFor="goal-template-title"
        hint={t("title.hint")}
        name="title"
        required
      >
        <Input
          id="goal-template-title"
          value={readString(params, "title")}
          onChange={(e) => onChange(patchParam(params, "title", e.target.value))}
          placeholder={t("title.placeholder")}
        />
      </Field>
      <Field
        label={t("objectiveText.label")}
        htmlFor="goal-template-objective"
        hint={t("objectiveText.hint")}
        name="objectiveText"
        required
      >
        <Textarea
          id="goal-template-objective"
          value={readString(params, "objectiveText")}
          onChange={(e) => onChange(patchParam(params, "objectiveText", e.target.value))}
          placeholder={t("objectiveText.placeholder")}
          rows={3}
        />
      </Field>
      <Field
        label={t("configJson.label")}
        htmlFor="goal-template-config"
        hint={t("configJson.hint")}
        name="configJson"
      >
        <Textarea
          id="goal-template-config"
          value={readString(params, "configJson")}
          onChange={(e) => {
            const next = patchParam(params, "configJson", e.target.value) as Record<string, unknown>
            const parsed = parseObjectJson(e.target.value)
            if (parsed) next.configOverrides = parsed
            onChange(next)
          }}
          rows={4}
          className="font-mono text-xs"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label={t("isFavorite.label")}
          htmlFor="goal-template-favorite"
          hint={t("isFavorite.hint")}
          name="isFavorite"
        >
          <Switch
            id="goal-template-favorite"
            checked={readBoolean(params, "isFavorite")}
            onCheckedChange={(v) => onChange(patchParam(params, "isFavorite", v))}
          />
        </Field>
        <Field
          label={t("sortOrder.label")}
          htmlFor="goal-template-sort"
          hint={t("sortOrder.hint")}
          name="sortOrder"
        >
          <Input
            id="goal-template-sort"
            type="number"
            value={sortOrder}
            onChange={(e) =>
              onChange(
                patchParam(params, "sortOrder", clampNumberInput(e.target.value, 0, 10000, 0))
              )
            }
          />
        </Field>
      </div>
    </FieldGroup>
  )
}

export function GoalTemplateFavoriteConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.goalTemplateFavorite")
  return (
    <FieldGroup>
      <GoalTemplateIdField params={params} onChange={onChange} id="goal-template-favorite-id" />
      <Field
        label={t("isFavorite.label")}
        htmlFor="goal-template-favorite-state"
        hint={t("isFavorite.hint")}
        name="isFavorite"
      >
        <Switch
          id="goal-template-favorite-state"
          checked={readBoolean(params, "isFavorite")}
          onCheckedChange={(v) => onChange(patchParam(params, "isFavorite", v))}
        />
      </Field>
    </FieldGroup>
  )
}

export function GoalTemplateDeleteConfig({ params, onChange }: ConfigProps) {
  return (
    <FieldGroup>
      <GoalTemplateIdField params={params} onChange={onChange} id="goal-template-delete-id" />
    </FieldGroup>
  )
}

const PLAN_SOURCES = [
  "manual",
  "agent_tool",
  "planner_llm",
  "team_projection",
  "goal_projection",
  "exit_plan_mode",
] as const

const PLAN_EXECUTION_MODES = ["auto", "in_session", "orchestrated"] as const
const PLAN_REFINEMENT_TYPES = ["optimize", "simplify", "expand", "reorder", "repair"] as const
const PLAN_REFINEMENT_TRIGGERS = ["manual", "step_failure", "judge_deviation"] as const
const PLAN_STATUSES = [
  "draft",
  "awaiting_approval",
  "approved",
  "executing",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const
const PLAN_STEP_STATUSES = [
  "pending",
  "ready",
  "in_progress",
  "completed",
  "failed",
  "skipped",
  "blocked",
] as const

const SCHEDULER_TASK_TYPES = [
  "workflow",
  "agent",
  "sync",
  "backup",
  "custom",
  "plugin",
  "script",
  "test",
  "ai-generation",
  "chat",
  "im-push",
  "skill",
  "external-agent",
  "agent-team",
  "goal",
  "plan",
  "twin",
  "connection:scheduled:digest",
  "connection:outbound:send",
  "wiki-rebuild",
] as const

const SCHEDULER_TRIGGER_TYPES = ["cron", "interval", "once", "event"] as const
const SCHEDULER_STATUSES = ["active", "paused", "disabled", "expired"] as const

function PlanIdField({ params, onChange, id }: { params: Params; onChange: ChangeFn; id: string }) {
  const t = useTranslations("workflows.forms.planCommon")
  return (
    <Field label={t("planId.label")} htmlFor={id} hint={t("planId.hint")} name="planId" required>
      <Input
        id={id}
        value={readString(params, "planId")}
        onChange={(e) => onChange(patchParam(params, "planId", e.target.value))}
        placeholder={t("planId.placeholder")}
      />
    </Field>
  )
}

export function PlanCreateConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.planCreate")
  const source = readString(params, "source", "manual")
  const executionMode = readString(params, "executionMode", "auto")
  return (
    <FieldGroup>
      <Field
        label={t("sessionId.label")}
        htmlFor="plan-create-session"
        hint={t("sessionId.hint")}
        name="sessionId"
        required
      >
        <Input
          id="plan-create-session"
          value={readString(params, "sessionId")}
          onChange={(e) => onChange(patchParam(params, "sessionId", e.target.value))}
          placeholder={t("sessionId.placeholder")}
        />
      </Field>
      <Field
        label={t("title.label")}
        htmlFor="plan-create-title"
        hint={t("title.hint")}
        name="title"
        required
      >
        <Input
          id="plan-create-title"
          value={readString(params, "title")}
          onChange={(e) => onChange(patchParam(params, "title", e.target.value))}
          placeholder={t("title.placeholder")}
        />
      </Field>
      <Field
        label={t("description.label")}
        htmlFor="plan-create-description"
        hint={t("description.hint")}
        name="description"
      >
        <Textarea
          id="plan-create-description"
          value={readString(params, "description")}
          onChange={(e) => onChange(patchParam(params, "description", e.target.value))}
          rows={2}
        />
      </Field>
      <Field label={t("characterId.label")} htmlFor="plan-create-character" name="characterId">
        <CharacterPicker
          id="plan-create-character"
          value={readString(params, "characterId")}
          onChange={(v) => onChange(patchParam(params, "characterId", v))}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("source.label")} htmlFor="plan-create-source" name="source">
          <Select value={source} onValueChange={(v) => onChange(patchParam(params, "source", v))}>
            <SelectTrigger id="plan-create-source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLAN_SOURCES.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`source.options.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          label={t("executionMode.label")}
          htmlFor="plan-create-execution-mode"
          name="executionMode"
        >
          <Select
            value={executionMode}
            onValueChange={(v) => onChange(patchParam(params, "executionMode", v))}
          >
            <SelectTrigger id="plan-create-execution-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLAN_EXECUTION_MODES.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`executionMode.options.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field
        label={t("stepsJson.label")}
        htmlFor="plan-create-steps"
        hint={t("stepsJson.hint")}
        name="stepsJson"
        required
      >
        <Textarea
          id="plan-create-steps"
          value={readString(params, "stepsJson")}
          onChange={(e) => {
            const next = patchParam(params, "stepsJson", e.target.value) as Record<string, unknown>
            const parsed = parseArrayJson(e.target.value)
            if (parsed) next.steps = parsed
            onChange(next)
          }}
          rows={5}
          className="font-mono text-xs"
        />
      </Field>
      <Field
        label={t("configJson.label")}
        htmlFor="plan-create-config"
        hint={t("configJson.hint")}
        name="configJson"
      >
        <Textarea
          id="plan-create-config"
          value={readString(params, "configJson")}
          onChange={(e) => {
            const next = patchParam(params, "configJson", e.target.value) as Record<string, unknown>
            const parsed = parseObjectJson(e.target.value)
            if (parsed) next.config = parsed
            onChange(next)
          }}
          rows={3}
          className="font-mono text-xs"
        />
      </Field>
      <Field
        label={t("metadataJson.label")}
        htmlFor="plan-create-metadata"
        hint={t("metadataJson.hint")}
        name="metadataJson"
      >
        <Textarea
          id="plan-create-metadata"
          value={readString(params, "metadataJson")}
          onChange={(e) => {
            const next = patchParam(params, "metadataJson", e.target.value) as Record<
              string,
              unknown
            >
            const parsed = parseObjectJson(e.target.value)
            if (parsed) next.metadata = parsed
            onChange(next)
          }}
          rows={3}
          className="font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  )
}

export function PlanListConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.planList")
  const mode = readString(params, "mode", "all")
  const status = readString(params, "status") || "any"
  const limit = readNumber(params, "limit", 500)
  return (
    <FieldGroup>
      <Field label={t("mode.label")} htmlFor="plan-list-mode" name="mode">
        <Select value={mode} onValueChange={(v) => onChange(patchParam(params, "mode", v))}>
          <SelectTrigger id="plan-list-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["all", "session", "openForSession", "executingForSession"].map((option) => (
              <SelectItem key={option} value={option}>
                {t(`mode.options.${option}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("sessionId.label")}
        htmlFor="plan-list-session"
        hint={t("sessionId.hint")}
        name="sessionId"
      >
        <Input
          id="plan-list-session"
          value={readString(params, "sessionId")}
          onChange={(e) => onChange(patchParam(params, "sessionId", e.target.value))}
        />
      </Field>
      <Field label={t("status.label")} htmlFor="plan-list-status" name="status">
        <Select
          value={status}
          onValueChange={(v) => onChange(patchParam(params, "status", v === "any" ? "" : v))}
        >
          <SelectTrigger id="plan-list-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">{t("status.options.any")}</SelectItem>
            {PLAN_STATUSES.map((option) => (
              <SelectItem key={option} value={option}>
                {t(`status.options.${option}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("projectId.label")}
        htmlFor="plan-list-project"
        hint={t("projectId.hint")}
        name="projectId"
      >
        <Input
          id="plan-list-project"
          value={readString(params, "projectId")}
          onChange={(e) => onChange(patchParam(params, "projectId", e.target.value))}
        />
      </Field>
      <Field label={t("limit.label")} htmlFor="plan-list-limit" hint={t("limit.hint")} name="limit">
        <Input
          id="plan-list-limit"
          type="number"
          min={1}
          max={1000}
          value={limit}
          onChange={(e) =>
            onChange(patchParam(params, "limit", clampNumberInput(e.target.value, 1, 1000, 500)))
          }
        />
      </Field>
    </FieldGroup>
  )
}

export function PlanEventsConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.planEvents")
  const limit = readNumber(params, "limit", 200)
  return (
    <FieldGroup>
      <PlanIdField params={params} onChange={onChange} id="plan-events-id" />
      <Field
        label={t("limit.label")}
        htmlFor="plan-events-limit"
        hint={t("limit.hint")}
        name="limit"
      >
        <Input
          id="plan-events-limit"
          type="number"
          min={1}
          max={5000}
          value={limit}
          onChange={(e) =>
            onChange(patchParam(params, "limit", clampNumberInput(e.target.value, 1, 5000, 200)))
          }
        />
      </Field>
    </FieldGroup>
  )
}

export function PlanTransitionConfig({ params, onChange }: ConfigProps) {
  return (
    <FieldGroup>
      <PlanIdField params={params} onChange={onChange} id="plan-transition-id" />
    </FieldGroup>
  )
}

export function PlanUpdateDraftConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.planUpdateDraft")
  const executionMode = readString(params, "executionMode") || "unchanged"
  return (
    <FieldGroup>
      <PlanIdField params={params} onChange={onChange} id="plan-update-id" />
      <Field
        label={t("title.label")}
        htmlFor="plan-update-title"
        hint={t("title.hint")}
        name="title"
      >
        <Input
          id="plan-update-title"
          value={readString(params, "title")}
          onChange={(e) => onChange(patchParam(params, "title", e.target.value))}
        />
      </Field>
      <Field
        label={t("description.label")}
        htmlFor="plan-update-description"
        hint={t("description.hint")}
        name="description"
      >
        <Textarea
          id="plan-update-description"
          value={readString(params, "description")}
          onChange={(e) => onChange(patchParam(params, "description", e.target.value))}
          rows={2}
        />
      </Field>
      <Field
        label={t("executionMode.label")}
        htmlFor="plan-update-execution-mode"
        name="executionMode"
      >
        <Select
          value={executionMode}
          onValueChange={(v) =>
            onChange(patchParam(params, "executionMode", v === "unchanged" ? "" : v))
          }
        >
          <SelectTrigger id="plan-update-execution-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="unchanged">{t("executionMode.options.unchanged")}</SelectItem>
            {PLAN_EXECUTION_MODES.map((option) => (
              <SelectItem key={option} value={option}>
                {t(`executionMode.options.${option}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("stepsJson.label")}
        htmlFor="plan-update-steps"
        hint={t("stepsJson.hint")}
        name="stepsJson"
      >
        <Textarea
          id="plan-update-steps"
          value={readString(params, "stepsJson")}
          onChange={(e) => {
            const next = patchParam(params, "stepsJson", e.target.value) as Record<string, unknown>
            const parsed = parseArrayJson(e.target.value)
            if (parsed) next.steps = parsed
            onChange(next)
          }}
          rows={5}
          className="font-mono text-xs"
        />
      </Field>
      <Field
        label={t("configJson.label")}
        htmlFor="plan-update-config"
        hint={t("configJson.hint")}
        name="configJson"
      >
        <Textarea
          id="plan-update-config"
          value={readString(params, "configJson")}
          onChange={(e) => {
            const next = patchParam(params, "configJson", e.target.value) as Record<string, unknown>
            const parsed = parseObjectJson(e.target.value)
            if (parsed) next.config = parsed
            onChange(next)
          }}
          rows={3}
          className="font-mono text-xs"
        />
      </Field>
      <Field
        label={t("metadataJson.label")}
        htmlFor="plan-update-metadata"
        hint={t("metadataJson.hint")}
        name="metadataJson"
      >
        <Textarea
          id="plan-update-metadata"
          value={readString(params, "metadataJson")}
          onChange={(e) => {
            const next = patchParam(params, "metadataJson", e.target.value) as Record<
              string,
              unknown
            >
            const parsed = parseObjectJson(e.target.value)
            if (parsed) next.metadata = parsed
            onChange(next)
          }}
          rows={3}
          className="font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  )
}

export function PlanRejectConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.planReject")
  return (
    <FieldGroup>
      <PlanIdField params={params} onChange={onChange} id="plan-reject-id" />
      <Field
        label={t("feedback.label")}
        htmlFor="plan-reject-feedback"
        hint={t("feedback.hint")}
        name="feedback"
      >
        <Textarea
          id="plan-reject-feedback"
          value={readString(params, "feedback")}
          onChange={(e) => onChange(patchParam(params, "feedback", e.target.value))}
          rows={3}
        />
      </Field>
    </FieldGroup>
  )
}

export function PlanRefineConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.planRefine")
  const refinementType = readString(params, "refinementType", "optimize")
  const trigger = readString(params, "trigger", "manual")
  return (
    <FieldGroup>
      <PlanIdField params={params} onChange={onChange} id="plan-refine-id" />
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("refinementType.label")} htmlFor="plan-refine-type" name="refinementType">
          <Select
            value={refinementType}
            onValueChange={(v) => onChange(patchParam(params, "refinementType", v))}
          >
            <SelectTrigger id="plan-refine-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLAN_REFINEMENT_TYPES.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`refinementType.options.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("trigger.label")} htmlFor="plan-refine-trigger" name="trigger">
          <Select value={trigger} onValueChange={(v) => onChange(patchParam(params, "trigger", v))}>
            <SelectTrigger id="plan-refine-trigger">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLAN_REFINEMENT_TRIGGERS.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`trigger.options.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field
        label={t("failedStepId.label")}
        htmlFor="plan-refine-failed-step"
        hint={t("failedStepId.hint")}
        name="failedStepId"
      >
        <Input
          id="plan-refine-failed-step"
          value={readString(params, "failedStepId")}
          onChange={(e) => onChange(patchParam(params, "failedStepId", e.target.value))}
        />
      </Field>
      <Field
        label={t("customInstructions.label")}
        htmlFor="plan-refine-instructions"
        hint={t("customInstructions.hint")}
        name="customInstructions"
      >
        <Textarea
          id="plan-refine-instructions"
          value={readString(params, "customInstructions")}
          onChange={(e) => onChange(patchParam(params, "customInstructions", e.target.value))}
          rows={3}
        />
      </Field>
    </FieldGroup>
  )
}

export function PlanSetStepStatusConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.planSetStepStatus")
  const status = readString(params, "status", "completed")
  const attempts = readNumber(params, "attempts", 0)
  return (
    <FieldGroup>
      <PlanIdField params={params} onChange={onChange} id="plan-step-plan-id" />
      <Field
        label={t("stepId.label")}
        htmlFor="plan-step-id"
        hint={t("stepId.hint")}
        name="stepId"
        required
      >
        <Input
          id="plan-step-id"
          value={readString(params, "stepId")}
          onChange={(e) => onChange(patchParam(params, "stepId", e.target.value))}
          placeholder={t("stepId.placeholder")}
        />
      </Field>
      <Field label={t("status.label")} htmlFor="plan-step-status" name="status" required>
        <Select value={status} onValueChange={(v) => onChange(patchParam(params, "status", v))}>
          <SelectTrigger id="plan-step-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PLAN_STEP_STATUSES.map((option) => (
              <SelectItem key={option} value={option}>
                {t(`status.options.${option}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("result.label")}
        htmlFor="plan-step-result"
        hint={t("result.hint")}
        name="result"
      >
        <Input
          id="plan-step-result"
          value={readString(params, "result")}
          onChange={(e) => onChange(patchParam(params, "result", e.target.value))}
        />
      </Field>
      <Field label={t("error.label")} htmlFor="plan-step-error" hint={t("error.hint")} name="error">
        <Input
          id="plan-step-error"
          value={readString(params, "error")}
          onChange={(e) => onChange(patchParam(params, "error", e.target.value))}
        />
      </Field>
      <Field
        label={t("outputJson.label")}
        htmlFor="plan-step-output"
        hint={t("outputJson.hint")}
        name="outputJson"
      >
        <Textarea
          id="plan-step-output"
          value={readString(params, "outputJson")}
          onChange={(e) => {
            const next = patchParam(params, "outputJson", e.target.value) as Record<string, unknown>
            const parsed = parseObjectJson(e.target.value)
            if (parsed) next.output = parsed
            onChange(next)
          }}
          rows={3}
          className="font-mono text-xs"
        />
      </Field>
      <Field
        label={t("attempts.label")}
        htmlFor="plan-step-attempts"
        hint={t("attempts.hint")}
        name="attempts"
      >
        <Input
          id="plan-step-attempts"
          type="number"
          min={0}
          value={attempts}
          onChange={(e) =>
            onChange(patchParam(params, "attempts", clampNumberInput(e.target.value, 0, 100, 0)))
          }
        />
      </Field>
    </FieldGroup>
  )
}

function patchJsonObjectField(
  params: Params,
  rawKey: string,
  rawValue: string,
  objectKey: string
): Params {
  const next = patchParam(params, rawKey, rawValue) as Record<string, unknown>
  const parsed = parseObjectJson(rawValue)
  if (parsed) next[objectKey] = parsed
  return next
}

function SchedulerTaskIdField({
  params,
  onChange,
  id,
}: {
  params: Params
  onChange: ChangeFn
  id: string
}) {
  const t = useTranslations("workflows.forms.schedulerTaskCommon")
  return (
    <Field label={t("taskId.label")} htmlFor={id} hint={t("taskId.hint")} name="taskId" required>
      <Input
        id={id}
        value={readString(params, "taskId")}
        onChange={(e) => onChange(patchParam(params, "taskId", e.target.value))}
        placeholder={t("taskId.placeholder")}
      />
    </Field>
  )
}

export function SchedulerTaskCreateConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.schedulerTaskCreate")
  const type = readString(params, "type", "custom")
  const triggerType = readString(params, "triggerType", "cron")
  const intervalMs = readNumber(params, "intervalMs", 60000)
  const jitterMs = readNumber(params, "jitterMs", 0)
  return (
    <FieldGroup>
      <Field
        label={t("name.label")}
        htmlFor="scheduler-create-name"
        hint={t("name.hint")}
        name="name"
        required
      >
        <Input
          id="scheduler-create-name"
          value={readString(params, "name")}
          onChange={(e) => onChange(patchParam(params, "name", e.target.value))}
          placeholder={t("name.placeholder")}
        />
      </Field>
      <Field
        label={t("description.label")}
        htmlFor="scheduler-create-description"
        hint={t("description.hint")}
        name="description"
      >
        <Textarea
          id="scheduler-create-description"
          value={readString(params, "description")}
          onChange={(e) => onChange(patchParam(params, "description", e.target.value))}
          rows={2}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("type.label")} htmlFor="scheduler-create-type" name="type" required>
          <Select value={type} onValueChange={(v) => onChange(patchParam(params, "type", v))}>
            <SelectTrigger id="scheduler-create-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCHEDULER_TASK_TYPES.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`type.options.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          label={t("triggerType.label")}
          htmlFor="scheduler-create-trigger"
          name="triggerType"
          required
        >
          <Select
            value={triggerType}
            onValueChange={(v) => onChange(patchParam(params, "triggerType", v))}
          >
            <SelectTrigger id="scheduler-create-trigger">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCHEDULER_TRIGGER_TYPES.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`triggerType.options.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field
        label={t("cronExpression.label")}
        htmlFor="scheduler-create-cron"
        hint={t("cronExpression.hint")}
        name="cronExpression"
      >
        <Input
          id="scheduler-create-cron"
          value={readString(params, "cronExpression")}
          onChange={(e) => onChange(patchParam(params, "cronExpression", e.target.value))}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label={t("intervalMs.label")}
          htmlFor="scheduler-create-interval"
          hint={t("intervalMs.hint")}
          name="intervalMs"
        >
          <Input
            id="scheduler-create-interval"
            type="number"
            min={1}
            value={intervalMs}
            onChange={(e) =>
              onChange(
                patchParam(
                  params,
                  "intervalMs",
                  clampNumberInput(e.target.value, 1, 86_400_000, 60000)
                )
              )
            }
          />
        </Field>
        <Field
          label={t("jitterMs.label")}
          htmlFor="scheduler-create-jitter"
          hint={t("jitterMs.hint")}
          name="jitterMs"
        >
          <Input
            id="scheduler-create-jitter"
            type="number"
            min={0}
            value={jitterMs}
            onChange={(e) =>
              onChange(
                patchParam(params, "jitterMs", clampNumberInput(e.target.value, 0, 86_400_000, 0))
              )
            }
          />
        </Field>
      </div>
      <Field
        label={t("runAt.label")}
        htmlFor="scheduler-create-run-at"
        hint={t("runAt.hint")}
        name="runAt"
      >
        <Input
          id="scheduler-create-run-at"
          value={readString(params, "runAt")}
          onChange={(e) => onChange(patchParam(params, "runAt", e.target.value))}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label={t("eventType.label")}
          htmlFor="scheduler-create-event-type"
          hint={t("eventType.hint")}
          name="eventType"
        >
          <Input
            id="scheduler-create-event-type"
            value={readString(params, "eventType")}
            onChange={(e) => onChange(patchParam(params, "eventType", e.target.value))}
          />
        </Field>
        <Field
          label={t("timezone.label")}
          htmlFor="scheduler-create-timezone"
          hint={t("timezone.hint")}
          name="timezone"
        >
          <Input
            id="scheduler-create-timezone"
            value={readString(params, "timezone")}
            onChange={(e) => onChange(patchParam(params, "timezone", e.target.value))}
          />
        </Field>
      </div>
      <Field
        label={t("dependsOnRaw.label")}
        htmlFor="scheduler-create-depends"
        hint={t("dependsOnRaw.hint")}
        name="dependsOnRaw"
      >
        <Input
          id="scheduler-create-depends"
          value={readString(params, "dependsOnRaw")}
          onChange={(e) => onChange(patchParam(params, "dependsOnRaw", e.target.value))}
        />
      </Field>
      <SchedulerTaskJsonFields
        params={params}
        onChange={onChange}
        namespace="schedulerTaskCreate"
        idPrefix="scheduler-create"
      />
    </FieldGroup>
  )
}

export function SchedulerTaskListConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.schedulerTaskList")
  const limit = readNumber(params, "limit", 500)
  return (
    <FieldGroup>
      <Field
        label={t("statusesRaw.label")}
        htmlFor="scheduler-list-statuses"
        hint={t("statusesRaw.hint")}
        name="statusesRaw"
      >
        <Input
          id="scheduler-list-statuses"
          value={readString(params, "statusesRaw")}
          onChange={(e) => onChange(patchParam(params, "statusesRaw", e.target.value))}
        />
      </Field>
      <Field
        label={t("typesRaw.label")}
        htmlFor="scheduler-list-types"
        hint={t("typesRaw.hint")}
        name="typesRaw"
      >
        <Input
          id="scheduler-list-types"
          value={readString(params, "typesRaw")}
          onChange={(e) => onChange(patchParam(params, "typesRaw", e.target.value))}
        />
      </Field>
      <Field
        label={t("tagsRaw.label")}
        htmlFor="scheduler-list-tags"
        hint={t("tagsRaw.hint")}
        name="tagsRaw"
      >
        <Input
          id="scheduler-list-tags"
          value={readString(params, "tagsRaw")}
          onChange={(e) => onChange(patchParam(params, "tagsRaw", e.target.value))}
        />
      </Field>
      <Field
        label={t("search.label")}
        htmlFor="scheduler-list-search"
        hint={t("search.hint")}
        name="search"
      >
        <Input
          id="scheduler-list-search"
          value={readString(params, "search")}
          onChange={(e) => onChange(patchParam(params, "search", e.target.value))}
        />
      </Field>
      <Field
        label={t("limit.label")}
        htmlFor="scheduler-list-limit"
        hint={t("limit.hint")}
        name="limit"
      >
        <Input
          id="scheduler-list-limit"
          type="number"
          min={1}
          max={1000}
          value={limit}
          onChange={(e) =>
            onChange(patchParam(params, "limit", clampNumberInput(e.target.value, 1, 1000, 500)))
          }
        />
      </Field>
    </FieldGroup>
  )
}

export function SchedulerTaskUpdateConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.schedulerTaskUpdate")
  const status = readString(params, "status") || "unchanged"
  const triggerType = readString(params, "triggerType") || "unchanged"
  const intervalMs = readNumber(params, "intervalMs", 60000)
  const jitterMs = readNumber(params, "jitterMs", 0)
  return (
    <FieldGroup>
      <SchedulerTaskIdField params={params} onChange={onChange} id="scheduler-update-id" />
      <Field
        label={t("name.label")}
        htmlFor="scheduler-update-name"
        hint={t("name.hint")}
        name="name"
      >
        <Input
          id="scheduler-update-name"
          value={readString(params, "name")}
          onChange={(e) => onChange(patchParam(params, "name", e.target.value))}
        />
      </Field>
      <Field
        label={t("description.label")}
        htmlFor="scheduler-update-description"
        hint={t("description.hint")}
        name="description"
      >
        <Textarea
          id="scheduler-update-description"
          value={readString(params, "description")}
          onChange={(e) => onChange(patchParam(params, "description", e.target.value))}
          rows={2}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("status.label")} htmlFor="scheduler-update-status" name="status">
          <Select
            value={status}
            onValueChange={(v) =>
              onChange(patchParam(params, "status", v === "unchanged" ? "" : v))
            }
          >
            <SelectTrigger id="scheduler-update-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unchanged">{t("status.options.unchanged")}</SelectItem>
              {SCHEDULER_STATUSES.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`status.options.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("triggerType.label")} htmlFor="scheduler-update-trigger" name="triggerType">
          <Select
            value={triggerType}
            onValueChange={(v) =>
              onChange(patchParam(params, "triggerType", v === "unchanged" ? "" : v))
            }
          >
            <SelectTrigger id="scheduler-update-trigger">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unchanged">{t("triggerType.options.unchanged")}</SelectItem>
              {SCHEDULER_TRIGGER_TYPES.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`triggerType.options.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field
        label={t("cronExpression.label")}
        htmlFor="scheduler-update-cron"
        hint={t("cronExpression.hint")}
        name="cronExpression"
      >
        <Input
          id="scheduler-update-cron"
          value={readString(params, "cronExpression")}
          onChange={(e) => onChange(patchParam(params, "cronExpression", e.target.value))}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label={t("intervalMs.label")}
          htmlFor="scheduler-update-interval"
          hint={t("intervalMs.hint")}
          name="intervalMs"
        >
          <Input
            id="scheduler-update-interval"
            type="number"
            min={1}
            value={intervalMs}
            onChange={(e) =>
              onChange(
                patchParam(
                  params,
                  "intervalMs",
                  clampNumberInput(e.target.value, 1, 86_400_000, 60000)
                )
              )
            }
          />
        </Field>
        <Field
          label={t("jitterMs.label")}
          htmlFor="scheduler-update-jitter"
          hint={t("jitterMs.hint")}
          name="jitterMs"
        >
          <Input
            id="scheduler-update-jitter"
            type="number"
            min={0}
            value={jitterMs}
            onChange={(e) =>
              onChange(
                patchParam(params, "jitterMs", clampNumberInput(e.target.value, 0, 86_400_000, 0))
              )
            }
          />
        </Field>
      </div>
      <Field
        label={t("runAt.label")}
        htmlFor="scheduler-update-run-at"
        hint={t("runAt.hint")}
        name="runAt"
      >
        <Input
          id="scheduler-update-run-at"
          value={readString(params, "runAt")}
          onChange={(e) => onChange(patchParam(params, "runAt", e.target.value))}
        />
      </Field>
      <Field
        label={t("eventType.label")}
        htmlFor="scheduler-update-event-type"
        hint={t("eventType.hint")}
        name="eventType"
      >
        <Input
          id="scheduler-update-event-type"
          value={readString(params, "eventType")}
          onChange={(e) => onChange(patchParam(params, "eventType", e.target.value))}
        />
      </Field>
      <Field
        label={t("timezone.label")}
        htmlFor="scheduler-update-timezone"
        hint={t("timezone.hint")}
        name="timezone"
      >
        <Input
          id="scheduler-update-timezone"
          value={readString(params, "timezone")}
          onChange={(e) => onChange(patchParam(params, "timezone", e.target.value))}
        />
      </Field>
      <Field
        label={t("dependsOnRaw.label")}
        htmlFor="scheduler-update-depends"
        hint={t("dependsOnRaw.hint")}
        name="dependsOnRaw"
      >
        <Input
          id="scheduler-update-depends"
          value={readString(params, "dependsOnRaw")}
          onChange={(e) => onChange(patchParam(params, "dependsOnRaw", e.target.value))}
        />
      </Field>
      <SchedulerTaskJsonFields
        params={params}
        onChange={onChange}
        namespace="schedulerTaskUpdate"
        idPrefix="scheduler-update"
      />
    </FieldGroup>
  )
}

export function SchedulerTaskIdConfig({ params, onChange }: ConfigProps) {
  return (
    <FieldGroup>
      <SchedulerTaskIdField params={params} onChange={onChange} id="scheduler-task-id" />
    </FieldGroup>
  )
}

export function SchedulerTaskExecutionsConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.schedulerTaskExecutions")
  const limit = readNumber(params, "limit", 200)
  return (
    <FieldGroup>
      <SchedulerTaskIdField params={params} onChange={onChange} id="scheduler-executions-id" />
      <Field
        label={t("limit.label")}
        htmlFor="scheduler-executions-limit"
        hint={t("limit.hint")}
        name="limit"
      >
        <Input
          id="scheduler-executions-limit"
          type="number"
          min={1}
          max={5000}
          value={limit}
          onChange={(e) =>
            onChange(patchParam(params, "limit", clampNumberInput(e.target.value, 1, 5000, 200)))
          }
        />
      </Field>
    </FieldGroup>
  )
}

export function SchedulerTaskBackfillConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.schedulerTaskBackfill")
  return (
    <FieldGroup>
      <SchedulerTaskIdField params={params} onChange={onChange} id="scheduler-backfill-id" />
      <div className="grid grid-cols-2 gap-3">
        <Field
          label={t("start.label")}
          htmlFor="scheduler-backfill-start"
          hint={t("start.hint")}
          name="start"
          required
        >
          <Input
            id="scheduler-backfill-start"
            value={readString(params, "start")}
            onChange={(e) => onChange(patchParam(params, "start", e.target.value))}
          />
        </Field>
        <Field
          label={t("end.label")}
          htmlFor="scheduler-backfill-end"
          hint={t("end.hint")}
          name="end"
          required
        >
          <Input
            id="scheduler-backfill-end"
            value={readString(params, "end")}
            onChange={(e) => onChange(patchParam(params, "end", e.target.value))}
          />
        </Field>
      </div>
    </FieldGroup>
  )
}

export function SchedulerTaskExportConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.schedulerTaskExport")
  return (
    <FieldGroup>
      <Field
        label={t("taskIdsRaw.label")}
        htmlFor="scheduler-export-task-ids"
        hint={t("taskIdsRaw.hint")}
        name="taskIdsRaw"
      >
        <Input
          id="scheduler-export-task-ids"
          value={readString(params, "taskIdsRaw")}
          onChange={(e) => onChange(patchParam(params, "taskIdsRaw", e.target.value))}
        />
      </Field>
    </FieldGroup>
  )
}

export function SchedulerTaskImportConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.schedulerTaskImport")
  const mode = readString(params, "mode", "merge")
  return (
    <FieldGroup>
      <Field label={t("mode.label")} htmlFor="scheduler-import-mode" name="mode">
        <Select value={mode} onValueChange={(v) => onChange(patchParam(params, "mode", v))}>
          <SelectTrigger id="scheduler-import-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="merge">{t("mode.options.merge")}</SelectItem>
            <SelectItem value="replace">{t("mode.options.replace")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("dataJson.label")}
        htmlFor="scheduler-import-data"
        hint={t("dataJson.hint")}
        name="dataJson"
        required
      >
        <Textarea
          id="scheduler-import-data"
          value={readString(params, "dataJson")}
          onChange={(e) => onChange(patchParam(params, "dataJson", e.target.value))}
          rows={5}
          className="font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  )
}

export function SchedulerStatusConfig() {
  return <FieldGroup>{null}</FieldGroup>
}

export function SchedulerStatisticsConfig() {
  return <FieldGroup>{null}</FieldGroup>
}

function SchedulerLimitConfig({
  params,
  onChange,
  namespace,
  id,
  fallback,
}: ConfigProps & {
  namespace: "schedulerUpcoming" | "schedulerExecutionsRecent"
  id: string
  fallback: number
}) {
  const t = useTranslations(`workflows.forms.${namespace}`)
  const limit = readNumber(params, "limit", fallback)
  return (
    <FieldGroup>
      <Field label={t("limit.label")} htmlFor={id} hint={t("limit.hint")} name="limit">
        <Input
          id={id}
          type="number"
          min={1}
          max={1000}
          value={limit}
          onChange={(e) =>
            onChange(
              patchParam(params, "limit", clampNumberInput(e.target.value, 1, 1000, fallback))
            )
          }
        />
      </Field>
    </FieldGroup>
  )
}

export function SchedulerUpcomingConfig(props: ConfigProps) {
  return (
    <SchedulerLimitConfig
      {...props}
      namespace="schedulerUpcoming"
      id="scheduler-upcoming-limit"
      fallback={100}
    />
  )
}

export function SchedulerExecutionsRecentConfig(props: ConfigProps) {
  return (
    <SchedulerLimitConfig
      {...props}
      namespace="schedulerExecutionsRecent"
      id="scheduler-executions-recent-limit"
      fallback={200}
    />
  )
}

export function SchedulerExecutionGetConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.schedulerExecutionGet")
  return (
    <FieldGroup>
      <Field
        label={t("executionId.label")}
        htmlFor="scheduler-execution-id"
        hint={t("executionId.hint")}
        name="executionId"
        required
      >
        <Input
          id="scheduler-execution-id"
          value={readString(params, "executionId")}
          onChange={(e) => onChange(patchParam(params, "executionId", e.target.value))}
          placeholder={t("executionId.placeholder")}
        />
      </Field>
    </FieldGroup>
  )
}

export function SchedulerEventTriggerConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.schedulerEventTrigger")
  return (
    <FieldGroup>
      <Field
        label={t("eventType.label")}
        htmlFor="scheduler-event-type"
        hint={t("eventType.hint")}
        name="eventType"
        required
      >
        <Input
          id="scheduler-event-type"
          value={readString(params, "eventType")}
          onChange={(e) => onChange(patchParam(params, "eventType", e.target.value))}
        />
      </Field>
      <Field
        label={t("eventSource.label")}
        htmlFor="scheduler-event-source"
        hint={t("eventSource.hint")}
        name="eventSource"
      >
        <Input
          id="scheduler-event-source"
          value={readString(params, "eventSource")}
          onChange={(e) => onChange(patchParam(params, "eventSource", e.target.value))}
        />
      </Field>
      <Field
        label={t("payloadJson.label")}
        htmlFor="scheduler-event-payload"
        hint={t("payloadJson.hint")}
        name="payloadJson"
      >
        <Textarea
          id="scheduler-event-payload"
          value={readString(params, "payloadJson")}
          onChange={(e) =>
            onChange(patchJsonObjectField(params, "payloadJson", e.target.value, "payload"))
          }
          rows={4}
          className="font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  )
}

function SchedulerTaskJsonFields({
  params,
  onChange,
  namespace,
  idPrefix,
}: {
  params: Params
  onChange: ChangeFn
  namespace: "schedulerTaskCreate" | "schedulerTaskUpdate"
  idPrefix: string
}) {
  const t = useTranslations(`workflows.forms.${namespace}`)
  return (
    <>
      <Field
        label={t("payloadJson.label")}
        htmlFor={`${idPrefix}-payload`}
        hint={t("payloadJson.hint")}
        name="payloadJson"
      >
        <Textarea
          id={`${idPrefix}-payload`}
          value={readString(params, "payloadJson")}
          onChange={(e) =>
            onChange(patchJsonObjectField(params, "payloadJson", e.target.value, "payload"))
          }
          rows={4}
          className="font-mono text-xs"
        />
      </Field>
      <Field
        label={t("configJson.label")}
        htmlFor={`${idPrefix}-config`}
        hint={t("configJson.hint")}
        name="configJson"
      >
        <Textarea
          id={`${idPrefix}-config`}
          value={readString(params, "configJson")}
          onChange={(e) =>
            onChange(patchJsonObjectField(params, "configJson", e.target.value, "config"))
          }
          rows={3}
          className="font-mono text-xs"
        />
      </Field>
      <Field
        label={t("notificationJson.label")}
        htmlFor={`${idPrefix}-notification`}
        hint={t("notificationJson.hint")}
        name="notificationJson"
      >
        <Textarea
          id={`${idPrefix}-notification`}
          value={readString(params, "notificationJson")}
          onChange={(e) =>
            onChange(
              patchJsonObjectField(params, "notificationJson", e.target.value, "notification")
            )
          }
          rows={3}
          className="font-mono text-xs"
        />
      </Field>
      <Field
        label={t("tagsRaw.label")}
        htmlFor={`${idPrefix}-tags`}
        hint={t("tagsRaw.hint")}
        name="tagsRaw"
      >
        <Input
          id={`${idPrefix}-tags`}
          value={readString(params, "tagsRaw")}
          onChange={(e) => onChange(patchParam(params, "tagsRaw", e.target.value))}
        />
      </Field>
      <Field
        label={t("endAt.label")}
        htmlFor={`${idPrefix}-end-at`}
        hint={t("endAt.hint")}
        name="endAt"
      >
        <Input
          id={`${idPrefix}-end-at`}
          value={readString(params, "endAt")}
          onChange={(e) => onChange(patchParam(params, "endAt", e.target.value))}
        />
      </Field>
      <Field
        label={t("onSuccessTaskIdsRaw.label")}
        htmlFor={`${idPrefix}-success-chain`}
        hint={t("onSuccessTaskIdsRaw.hint")}
        name="onSuccessTaskIdsRaw"
      >
        <Input
          id={`${idPrefix}-success-chain`}
          value={readString(params, "onSuccessTaskIdsRaw")}
          onChange={(e) => onChange(patchParam(params, "onSuccessTaskIdsRaw", e.target.value))}
        />
      </Field>
      <Field
        label={t("onFailureTaskIdsRaw.label")}
        htmlFor={`${idPrefix}-failure-chain`}
        hint={t("onFailureTaskIdsRaw.hint")}
        name="onFailureTaskIdsRaw"
      >
        <Input
          id={`${idPrefix}-failure-chain`}
          value={readString(params, "onFailureTaskIdsRaw")}
          onChange={(e) => onChange(patchParam(params, "onFailureTaskIdsRaw", e.target.value))}
        />
      </Field>
    </>
  )
}

// ── action.character.send ─────────────────────────────────────────────────
export function CharacterSendConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.characterSend")
  const characterId = readString(params, "characterId")
  const content = readString(params, "content")
  const sessionId = readString(params, "sessionId")
  return (
    <FieldGroup>
      <Field label={t("character.label")} htmlFor="cs-char" name="characterId" required>
        <CharacterPicker
          id="cs-char"
          value={characterId}
          onChange={(v) => onChange(patchParam(params, "characterId", v))}
        />
      </Field>
      <Field
        label={t("content.label")}
        htmlFor="cs-content"
        hint={t("content.hint")}
        name="content"
        required
      >
        <ExpressionField
          id="cs-content"
          value={content}
          onChange={(v) => onChange(patchParam(params, "content", v))}
          multiline
          rows={4}
          placeholder={t("content.placeholder")}
        />
      </Field>
      <Field label={t("sessionId.label")} htmlFor="cs-session" name="sessionId">
        <Input
          id="cs-session"
          value={sessionId}
          onChange={(e) => onChange(patchParam(params, "sessionId", e.target.value))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.team.run ───────────────────────────────────────────────────────
export function TeamRunConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.teamRun")
  const teamId = readString(params, "teamId")
  const goal = readString(params, "goal")
  return (
    <FieldGroup>
      <Field label={t("teamId.label")} htmlFor="tr-team" name="teamId" required>
        <TeamPicker
          id="tr-team"
          value={teamId}
          onChange={(v) => onChange(patchParam(params, "teamId", v))}
        />
      </Field>
      <Field label={t("goal.label")} htmlFor="tr-goal" hint={t("goal.hint")} name="goal" required>
        <Textarea
          id="tr-goal"
          value={goal}
          onChange={(e) => onChange(patchParam(params, "goal", e.target.value))}
          rows={4}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.agent.turn ─────────────────────────────────────────────────────
export function AgentTurnConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.agentTurn")
  const prompt = readString(params, "prompt")
  const characterId = readString(params, "characterId")
  const systemPrompt = readString(params, "systemPrompt")
  const model = readString(params, "model")
  const allowedTools = Array.isArray(params.allowedTools)
    ? (params.allowedTools as string[]).join(", ")
    : ""
  const maxTurns = readNumber(params, "maxTurns", 10)
  const toolsEnabled = readBoolean(params, "toolsEnabled", true)
  const requireTools = readBoolean(params, "requireTools", false)
  const cwd = readString(params, "cwd")
  return (
    <FieldGroup>
      <Field label={t("prompt.label")} htmlFor="at-prompt" name="prompt" required>
        <ExpressionField
          id="at-prompt"
          value={prompt}
          onChange={(v) => onChange(patchParam(params, "prompt", v))}
          multiline
          rows={4}
        />
      </Field>
      <Field
        label={t("characterId.label")}
        htmlFor="at-char"
        hint={t("characterId.hint")}
        name="characterId"
      >
        <CharacterPicker
          id="at-char"
          value={characterId}
          onChange={(v) => onChange(patchParam(params, "characterId", v))}
        />
      </Field>
      {!characterId ? (
        <>
          <Field
            label={t("systemPrompt.label")}
            htmlFor="at-system"
            hint={t("systemPrompt.hint")}
            name="systemPrompt"
          >
            <ExpressionField
              id="at-system"
              value={systemPrompt}
              onChange={(v) => onChange(patchParam(params, "systemPrompt", v))}
              multiline
              rows={3}
            />
          </Field>
          <Field label={t("model.label")} htmlFor="at-model" hint={t("model.hint")} name="model">
            <Input
              id="at-model"
              value={model}
              onChange={(e) => onChange(patchParam(params, "model", e.target.value))}
            />
          </Field>
          <Field
            label={t("allowedTools.label")}
            htmlFor="at-tools"
            hint={t("allowedTools.hint")}
            name="allowedTools"
          >
            <Input
              id="at-tools"
              value={allowedTools}
              onChange={(e) => {
                const list = e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
                onChange(patchParam(params, "allowedTools", list.length > 0 ? list : undefined))
              }}
              placeholder={t("allowedTools.placeholder")}
            />
          </Field>
        </>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <Field
          label={t("maxTurns.label")}
          htmlFor="at-max"
          hint={t("maxTurns.hint")}
          name="maxTurns"
        >
          <Input
            id="at-max"
            type="number"
            min={1}
            max={100}
            value={maxTurns}
            onChange={(e) => onChange(patchParam(params, "maxTurns", Number(e.target.value) || 1))}
          />
        </Field>
        <Field label={t("cwd.label")} htmlFor="at-cwd" hint={t("cwd.hint")} name="cwd">
          <Input
            id="at-cwd"
            value={cwd}
            onChange={(e) => onChange(patchParam(params, "cwd", e.target.value))}
          />
        </Field>
      </div>
      <Field
        label={t("toolsEnabled.label")}
        htmlFor="at-tools-on"
        hint={t("toolsEnabled.hint")}
        name="toolsEnabled"
      >
        <Switch
          id="at-tools-on"
          checked={toolsEnabled}
          onCheckedChange={(v) => onChange(patchParam(params, "toolsEnabled", v))}
        />
      </Field>
      {toolsEnabled ? (
        <Field
          label={t("requireTools.label")}
          htmlFor="at-require"
          hint={t("requireTools.hint")}
          name="requireTools"
        >
          <Switch
            id="at-require"
            checked={requireTools}
            onCheckedChange={(v) => onChange(patchParam(params, "requireTools", v))}
          />
        </Field>
      ) : null}
    </FieldGroup>
  )
}

// ── action.skill.invoke ───────────────────────────────────────────────────
export function SkillInvokeConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.skillInvoke")
  const skillIds = readString(params, "skillIds")
  return (
    <FieldGroup>
      <Field
        label={t("skillIds.label")}
        htmlFor="si-ids"
        hint={t("skillIds.hint")}
        name="skillIds"
        required
      >
        <Input
          id="si-ids"
          value={skillIds}
          onChange={(e) => onChange(patchParam(params, "skillIds", e.target.value))}
          placeholder={t("skillIds.placeholder")}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.twin.rag ───────────────────────────────────────────────────────
export function TwinRagConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.twinRag")
  const twinId = readString(params, "twinId")
  const query = readString(params, "query")
  const topK = readNumber(params, "topK", 6)
  return (
    <FieldGroup>
      <Field label={t("twinId.label")} htmlFor="tr-twin" name="twinId" required>
        <TwinPicker
          id="tr-twin"
          value={twinId}
          onChange={(v) => onChange(patchParam(params, "twinId", v))}
        />
      </Field>
      <Field
        label={t("query.label")}
        htmlFor="tr-query"
        hint={t("query.hint")}
        name="query"
        required
      >
        <Textarea
          id="tr-query"
          value={query}
          onChange={(e) => onChange(patchParam(params, "query", e.target.value))}
          rows={3}
          placeholder={t("query.placeholder")}
        />
      </Field>
      <Field label={t("topK.label")} htmlFor="tr-topk" hint={t("topK.hint")} name="topK">
        <Input
          id="tr-topk"
          type="number"
          min={1}
          max={50}
          value={topK}
          onChange={(e) => onChange(patchParam(params, "topK", Number(e.target.value) || 1))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.connector.send ─────────────────────────────────────────────────
export function ConnectorSendConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.connectorSend")
  const adapterId = readString(params, "adapterId")
  const conversationKey = readString(params, "conversationKey")
  const content = readString(params, "content")
  return (
    <FieldGroup>
      <Field label={t("adapter.label")} htmlFor="cs-adapter" name="adapterId" required>
        <Input
          id="cs-adapter"
          value={adapterId}
          onChange={(e) => onChange(patchParam(params, "adapterId", e.target.value))}
          placeholder={t("adapter.placeholder")}
        />
      </Field>
      <Field label={t("conversationKey.label")} htmlFor="cs-conv" name="conversationKey" required>
        <Input
          id="cs-conv"
          value={conversationKey}
          onChange={(e) => onChange(patchParam(params, "conversationKey", e.target.value))}
        />
      </Field>
      <Field label={t("content.label")} htmlFor="cs-content" name="content" required>
        <Textarea
          id="cs-content"
          value={content}
          onChange={(e) => onChange(patchParam(params, "content", e.target.value))}
          rows={4}
        />
      </Field>
    </FieldGroup>
  )
}

// ── ai.prompt ─────────────────────────────────────────────────────────────
export function AiPromptConfig({ params, onChange, typeVersion }: ConfigProps) {
  const t = useTranslations("workflows.forms.aiPrompt")
  const v2 = (typeVersion ?? 1) >= 2
  const mode = (readString(params, "mode") || "explicit") as "explicit" | "routed"
  const routed = v2 && mode === "routed"
  const modelAlias = readString(params, "modelAlias")
  const piiGate = readString(params, "piiGate") || "off"
  const provider = readString(params, "provider")
  const model = readString(params, "model")
  const apiKey = readString(params, "apiKey")
  const baseURL = readString(params, "baseURL")
  const systemPrompt = readString(params, "systemPrompt")
  const userPrompt = readString(params, "userPrompt")
  const temperature = readNumber(params, "temperature", 0.7)
  const responseFormat = readString(params, "responseFormat") || "text"
  const jsonSchema = readString(params, "jsonSchema")
  return (
    <FieldGroup>
      {v2 ? (
        <Field label={t("mode.label")} htmlFor="ai-mode" hint={t("mode.hint")} name="mode">
          <Select value={mode} onValueChange={(v) => onChange(patchParam(params, "mode", v))}>
            <SelectTrigger id="ai-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="explicit">{t("mode.explicit")}</SelectItem>
              <SelectItem value="routed">{t("mode.routed")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      {routed ? (
        <Field
          label={t("modelAlias.label")}
          htmlFor="ai-alias"
          hint={t("modelAlias.hint")}
          name="modelAlias"
        >
          <Input
            id="ai-alias"
            value={modelAlias}
            onChange={(e) => onChange(patchParam(params, "modelAlias", e.target.value))}
            placeholder={t("modelAlias.placeholder")}
          />
        </Field>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("provider.label")} htmlFor="ai-provider" name="provider">
              <Select
                value={provider || undefined}
                onValueChange={(v) => onChange(patchParam(params, "provider", v))}
              >
                <SelectTrigger id="ai-provider">
                  <SelectValue placeholder={t("provider.placeholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="google">Google</SelectItem>
                  <SelectItem value="mistral">Mistral</SelectItem>
                  <SelectItem value="cohere">Cohere</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("model.label")} htmlFor="ai-model" hint={t("model.hint")} name="model">
              <Input
                id="ai-model"
                value={model}
                onChange={(e) => onChange(patchParam(params, "model", e.target.value))}
                placeholder={t("model.placeholder")}
              />
            </Field>
          </div>
          <Field label={t("apiKey.label")} htmlFor="ai-key" hint={t("apiKey.hint")} name="apiKey">
            <Input
              id="ai-key"
              type="password"
              value={apiKey}
              onChange={(e) => onChange(patchParam(params, "apiKey", e.target.value))}
            />
          </Field>
          <Field
            label={t("baseURL.label")}
            htmlFor="ai-base"
            hint={t("baseURL.hint")}
            name="baseURL"
          >
            <Input
              id="ai-base"
              value={baseURL}
              onChange={(e) => onChange(patchParam(params, "baseURL", e.target.value))}
              placeholder={t("baseURL.placeholder")}
            />
          </Field>
        </>
      )}
      {v2 ? (
        <Field label={t("piiGate.label")} htmlFor="ai-pii" hint={t("piiGate.hint")} name="piiGate">
          <Select value={piiGate} onValueChange={(v) => onChange(patchParam(params, "piiGate", v))}>
            <SelectTrigger id="ai-pii">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">{t("piiGate.off")}</SelectItem>
              <SelectItem value="block">{t("piiGate.block")}</SelectItem>
              <SelectItem value="redact">{t("piiGate.redact")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      <Field label={t("systemPrompt.label")} htmlFor="ai-system" name="systemPrompt">
        <ExpressionField
          id="ai-system"
          value={systemPrompt}
          onChange={(v) => onChange(patchParam(params, "systemPrompt", v))}
          multiline
          rows={3}
        />
      </Field>
      <Field label={t("userPrompt.label")} htmlFor="ai-user" name="userPrompt" required>
        <ExpressionField
          id="ai-user"
          value={userPrompt}
          onChange={(v) => onChange(patchParam(params, "userPrompt", v))}
          multiline
          rows={5}
        />
      </Field>
      <Field
        label={t("temperature.label")}
        htmlFor="ai-temp"
        hint={t("temperature.hint")}
        name="temperature"
      >
        <Input
          id="ai-temp"
          type="number"
          step={0.1}
          min={0}
          max={2}
          value={temperature}
          onChange={(e) => onChange(patchParam(params, "temperature", Number(e.target.value) || 0))}
        />
      </Field>
      <Field
        label={t("responseFormat.label")}
        htmlFor="ai-format"
        hint={t("responseFormat.hint")}
        name="responseFormat"
      >
        <Select
          value={responseFormat}
          onValueChange={(v) => onChange(patchParam(params, "responseFormat", v))}
        >
          <SelectTrigger id="ai-format">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="text">{t("responseFormat.text")}</SelectItem>
            <SelectItem value="json">{t("responseFormat.json")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {responseFormat === "json" ? (
        <Field
          label={t("jsonSchema.label")}
          htmlFor="ai-schema"
          hint={t("jsonSchema.hint")}
          name="jsonSchema"
        >
          <Textarea
            id="ai-schema"
            value={jsonSchema}
            onChange={(e) => onChange(patchParam(params, "jsonSchema", e.target.value))}
            rows={4}
            className="font-mono text-xs"
            placeholder={t("jsonSchema.placeholder")}
          />
        </Field>
      ) : null}
    </FieldGroup>
  )
}

// ── flow.branch ───────────────────────────────────────────────────────────
export function BranchConfig({ params, onChange, typeVersion }: ConfigProps) {
  const t = useTranslations("workflows.forms.branch")
  if ((typeVersion ?? 1) >= 2) {
    return <BranchConfigV2 params={params} onChange={onChange} />
  }
  return <BranchConfigV1 params={params} onChange={onChange} t={t} />
}

/** typeVersion 2 — structured condition group routing to true/false handles. */
function BranchConfigV2({ params, onChange }: { params: Params; onChange: ChangeFn }) {
  const t = useTranslations("workflows.forms.branch")
  const conditions = (params.conditions ?? undefined) as WorkflowConditionGroup | undefined
  return (
    <FieldGroup>
      <Field
        label={t("conditions.label")}
        htmlFor="br-conditions"
        hint={t("conditions.hint")}
        name="conditions"
        required
      >
        <ConditionBuilder
          idPrefix="branch-conditions"
          value={conditions}
          onChange={(next) => onChange(patchParam(params, "conditions", next))}
        />
      </Field>
    </FieldGroup>
  )
}

function BranchConfigV1({
  params,
  onChange,
  t,
}: {
  params: Params
  onChange: ChangeFn
  t: ReturnType<typeof useTranslations>
}) {
  const condition = readString(params, "condition")
  const truthy = readString(params, "truthyLabel", "true")
  const falsy = readString(params, "falsyLabel", "false")
  return (
    <FieldGroup>
      <Field
        label={t("condition.label")}
        htmlFor="br-cond"
        hint={t("condition.hint")}
        name="condition"
        required
      >
        <ExpressionField
          id="br-cond"
          value={condition}
          onChange={(v) => onChange(patchParam(params, "condition", v))}
          multiline
          rows={2}
          placeholder={t("condition.placeholder")}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("truthyLabel.label")} htmlFor="br-tlabel" name="truthyLabel">
          <Input
            id="br-tlabel"
            value={truthy}
            onChange={(e) => onChange(patchParam(params, "truthyLabel", e.target.value))}
          />
        </Field>
        <Field label={t("falsyLabel.label")} htmlFor="br-flabel" name="falsyLabel">
          <Input
            id="br-flabel"
            value={falsy}
            onChange={(e) => onChange(patchParam(params, "falsyLabel", e.target.value))}
          />
        </Field>
      </div>
    </FieldGroup>
  )
}

// ── flow.set ──────────────────────────────────────────────────────────────
export function SetVariableConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.setVariable")
  const variable = readString(params, "variable")
  const value = readString(params, "value")
  return (
    <FieldGroup>
      <Field label={t("variable.label")} htmlFor="sv-name" name="variable" required>
        <Input
          id="sv-name"
          value={variable}
          onChange={(e) => onChange(patchParam(params, "variable", e.target.value))}
          placeholder={t("variable.placeholder")}
        />
      </Field>
      <Field
        label={t("value.label")}
        htmlFor="sv-value"
        hint={t("value.hint")}
        name="value"
        required
      >
        <ExpressionField
          id="sv-value"
          value={value}
          onChange={(v) => onChange(patchParam(params, "value", v))}
          multiline
          rows={2}
        />
      </Field>
    </FieldGroup>
  )
}

// ── flow.wait ─────────────────────────────────────────────────────────────
export function WaitConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.wait")
  const mode = readString(params, "mode", "duration")
  const durationMs = readNumber(params, "durationMs", 1000)
  return (
    <FieldGroup>
      <Field label={t("mode.label")} htmlFor="w-mode" name="mode">
        <Select value={mode} onValueChange={(v) => onChange(patchParam(params, "mode", v))}>
          <SelectTrigger id="w-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="duration">{t("mode.options.duration")}</SelectItem>
            <SelectItem value="event">{t("mode.options.event")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {mode === "duration" ? (
        <Field
          label={t("durationMs.label")}
          htmlFor="w-dur"
          hint={t("durationMs.hint")}
          name="durationMs"
        >
          <DurationField
            id="w-dur"
            value={durationMs}
            onChange={(next) => onChange(patchParam(params, "durationMs", next))}
          />
        </Field>
      ) : null}
    </FieldGroup>
  )
}

// ── io.http ───────────────────────────────────────────────────────────────
export function HttpRequestConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.httpRequest")
  const method = readString(params, "method", "GET")
  const url = readString(params, "url")
  const body = readString(params, "body")
  const followRedirects = readBoolean(params, "followRedirects", true)
  return (
    <FieldGroup>
      <Field label={t("method.label")} htmlFor="http-method" name="method">
        <Select value={method} onValueChange={(v) => onChange(patchParam(params, "method", v))}>
          <SelectTrigger id="http-method">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="GET">GET</SelectItem>
            <SelectItem value="POST">POST</SelectItem>
            <SelectItem value="PUT">PUT</SelectItem>
            <SelectItem value="PATCH">PATCH</SelectItem>
            <SelectItem value="DELETE">DELETE</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label={t("url.label")} htmlFor="http-url" hint={t("url.hint")} name="url" required>
        <Input
          id="http-url"
          value={url}
          onChange={(e) => onChange(patchParam(params, "url", e.target.value))}
          placeholder={t("url.placeholder")}
        />
      </Field>
      {method !== "GET" ? (
        <Field label={t("body.label")} htmlFor="http-body" hint={t("body.hint")} name="body">
          <ExpressionField
            id="http-body"
            value={body}
            onChange={(v) => onChange(patchParam(params, "body", v))}
            multiline
            rows={4}
          />
        </Field>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <Field
          label={t("followRedirects.label")}
          htmlFor="http-follow"
          hint={t("followRedirects.hint")}
          name="followRedirects"
        >
          <Switch
            id="http-follow"
            checked={followRedirects}
            onCheckedChange={(v) => onChange(patchParam(params, "followRedirects", v))}
          />
        </Field>
      </div>
    </FieldGroup>
  )
}

// ── data.code ─────────────────────────────────────────────────────────────
export function CodeConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.code")
  const code = readString(
    params,
    "code",
    "// upstream is the merged outputs of all parents.\nreturn { result: upstream }"
  )
  return (
    <FieldGroup>
      <Field label={t("code.label")} htmlFor="code-body" hint={t("code.hint")} name="code" required>
        <Textarea
          id="code-body"
          value={code}
          onChange={(e) => onChange(patchParam(params, "code", e.target.value))}
          rows={10}
          className="font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  )
}

// ── data.template ─────────────────────────────────────────────────────────
export function TemplateConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.template")
  const template = readString(params, "template")
  return (
    <FieldGroup>
      <Field
        label={t("template.label")}
        htmlFor="tmpl"
        hint={t("template.hint")}
        name="template"
        required
      >
        <ExpressionField
          id="tmpl"
          value={template}
          onChange={(v) => onChange(patchParam(params, "template", v))}
          multiline
          rows={6}
        />
      </Field>
    </FieldGroup>
  )
}

// ── data.transform ────────────────────────────────────────────────────────
export function TransformConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.transform")
  const op = readString(params, "operation", "map")
  const expression = readString(params, "expression")
  return (
    <FieldGroup>
      <Field label={t("operation.label")} htmlFor="tr-op" name="operation">
        <Select value={op} onValueChange={(v) => onChange(patchParam(params, "operation", v))}>
          <SelectTrigger id="tr-op">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="map">{t("operation.options.map")}</SelectItem>
            <SelectItem value="filter">{t("operation.options.filter")}</SelectItem>
            <SelectItem value="reduce">{t("operation.options.reduce")}</SelectItem>
            <SelectItem value="sort">{t("operation.options.sort")}</SelectItem>
            <SelectItem value="flatten">{t("operation.options.flatten")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("expression.label")}
        htmlFor="tr-expr"
        hint={t("expression.hint")}
        name="expression"
        required
      >
        <ExpressionField
          id="tr-expr"
          value={expression}
          onChange={(v) => onChange(patchParam(params, "expression", v))}
          multiline
          rows={3}
        />
      </Field>
    </FieldGroup>
  )
}

// ── annotation.note ───────────────────────────────────────────────────────
const NOTE_COLOR_OPTIONS: Array<{
  value: "yellow" | "green" | "blue" | "pink" | "violet"
  swatch: string
}> = [
  { value: "yellow", swatch: "bg-amber-200" },
  { value: "green", swatch: "bg-emerald-200" },
  { value: "blue", swatch: "bg-sky-200" },
  { value: "pink", swatch: "bg-pink-200" },
  { value: "violet", swatch: "bg-violet-200" },
]

export function NoteConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.note")
  const text = readString(params, "text")
  const color = readString(params, "color", "yellow")
  return (
    <FieldGroup>
      <Field label={t("text.label")} htmlFor="note-text" name="text">
        <Textarea
          id="note-text"
          value={text}
          onChange={(e) => onChange(patchParam(params, "text", e.target.value))}
          rows={6}
        />
      </Field>
      <Field label={t("color.label")} htmlFor="note-color" name="color">
        <div
          id="note-color"
          role="radiogroup"
          aria-label={t("color.ariaGroup")}
          className="flex gap-1.5"
        >
          {NOTE_COLOR_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={color === opt.value}
              aria-label={t(`color.options.${opt.value}`)}
              data-testid={`note-color-${opt.value}`}
              onClick={() => onChange(patchParam(params, "color", opt.value))}
              className={`size-6 rounded-full border-2 transition ${opt.swatch} ${
                color === opt.value
                  ? "border-foreground scale-110"
                  : "border-transparent hover:scale-105"
              }`}
            />
          ))}
        </div>
      </Field>
    </FieldGroup>
  )
}

// ── generic JSON fallback ─────────────────────────────────────────────────
export function GenericJsonConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.genericJson")
  const [text, setText] = useState(() => JSON.stringify(params, null, 2))
  const [error, setError] = useState<string | null>(null)
  // Reset text when params change externally (e.g., undo) — render-time setState.
  const [prevParams, setPrevParams] = useState(params)
  if (prevParams !== params) {
    setPrevParams(params)
    setText(JSON.stringify(params, null, 2))
    setError(null)
  }
  return (
    <FieldGroup>
      <Field label={t("params.label")} htmlFor="gen-json" hint={t("params.hint")}>
        <Textarea
          id="gen-json"
          value={text}
          onChange={(e) => {
            const next = e.target.value
            setText(next)
            try {
              const parsed = JSON.parse(next)
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                onChange(parsed as Record<string, unknown>)
                setError(null)
              } else {
                setError(t("errorTopLevelObject"))
              }
            } catch (err) {
              setError(err instanceof Error ? err.message : t("errorInvalidJson"))
            }
          }}
          rows={10}
          className="font-mono text-xs"
        />
      </Field>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </FieldGroup>
  )
}

// Banner that fetches the live webhook URL for the current node and shows
// it (or a "save first" hint when the trigger hasn't been registered yet).
function WebhookUrlBanner() {
  const t = useTranslations("workflows.forms.webhookBanner")
  const ctx = useInspectorExpressionCtx()
  const [url, setUrl] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const triggerId = ctx?.currentNodeId
  useEffect(() => {
    if (!triggerId) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPending(true)
    void getWebhookUrl(triggerId)
      .then((u) => {
        if (!cancelled) setUrl(u)
      })
      .finally(() => {
        if (!cancelled) setPending(false)
      })
    return () => {
      cancelled = true
    }
  }, [triggerId])
  return (
    <div className="rounded-md border border-wf-status-running/40 bg-wf-status-running/5 px-2.5 py-2 text-[11px] space-y-1">
      <p className="text-wf-status-running">{t("desktopOnly")}</p>
      {url ? (
        <p className="font-mono break-all text-foreground">
          <span className="text-muted-foreground">{t("urlLabel")}</span>
          {url}
        </p>
      ) : (
        <p className="text-muted-foreground">{pending ? t("loading") : t("saveFirst")}</p>
      )}
    </div>
  )
}

// ── trigger.webhook ───────────────────────────────────────────────────────
export function WebhookTriggerConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.webhookTrigger")
  const path = readString(params, "path")
  const method = readString(params, "method", "POST")
  const hmacSecret = readString(params, "hmacSecret")
  const responseStatus = readNumber(params, "responseStatus", 200)
  const responseTemplate = readString(params, "responseTemplate")
  return (
    <FieldGroup>
      <WebhookUrlBanner />
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("method.label")} htmlFor="wh-method" name="method">
          <Select value={method} onValueChange={(v) => onChange(patchParam(params, "method", v))}>
            <SelectTrigger id="wh-method">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="POST">POST</SelectItem>
              <SelectItem value="GET">GET</SelectItem>
              <SelectItem value="PUT">PUT</SelectItem>
              <SelectItem value="PATCH">PATCH</SelectItem>
              <SelectItem value="DELETE">DELETE</SelectItem>
              <SelectItem value="*">{t("method.options.any")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("path.label")} htmlFor="wh-path" hint={t("path.hint")} name="path" required>
          <Input
            id="wh-path"
            value={path}
            onChange={(e) => onChange(patchParam(params, "path", e.target.value))}
            placeholder={t("path.placeholder")}
            className="font-mono text-xs"
          />
        </Field>
      </div>
      <Field
        label={t("hmacSecret.label")}
        htmlFor="wh-hmac"
        hint={t("hmacSecret.hint")}
        name="hmacSecret"
      >
        <Input
          id="wh-hmac"
          type="password"
          value={hmacSecret}
          onChange={(e) => onChange(patchParam(params, "hmacSecret", e.target.value))}
        />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field
          label={t("responseStatus.label")}
          htmlFor="wh-status"
          className="col-span-1"
          name="responseStatus"
        >
          <Input
            id="wh-status"
            type="number"
            min={100}
            max={599}
            value={responseStatus}
            onChange={(e) =>
              onChange(patchParam(params, "responseStatus", Number(e.target.value) || 200))
            }
          />
        </Field>
        <Field
          label={t("responseTemplate.label")}
          htmlFor="wh-resp"
          hint={t("responseTemplate.hint")}
          className="col-span-2"
          name="responseTemplate"
        >
          <Input
            id="wh-resp"
            value={responseTemplate}
            onChange={(e) => onChange(patchParam(params, "responseTemplate", e.target.value))}
            placeholder={t("responseTemplate.placeholder")}
            className="font-mono text-xs"
          />
        </Field>
      </div>
    </FieldGroup>
  )
}

// ── action.character.create ───────────────────────────────────────────────
export function CharacterCreateConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.characterCreate")
  const name = readString(params, "name")
  const systemPrompt = readString(params, "systemPrompt")
  const description = readString(params, "description")
  const avatarColor = readString(params, "avatarColor")
  const avatarEmoji = readString(params, "avatarEmoji")
  const model = readString(params, "model")
  return (
    <FieldGroup>
      <Field label={t("name.label")} htmlFor="cc-name" name="name" required>
        <Input
          id="cc-name"
          value={name}
          onChange={(e) => onChange(patchParam(params, "name", e.target.value))}
          placeholder={t("name.placeholder")}
        />
      </Field>
      <Field
        label={t("systemPrompt.label")}
        htmlFor="cc-sys"
        hint={t("systemPrompt.hint")}
        name="systemPrompt"
        required
      >
        <Textarea
          id="cc-sys"
          value={systemPrompt}
          onChange={(e) => onChange(patchParam(params, "systemPrompt", e.target.value))}
          rows={5}
        />
      </Field>
      <Field label={t("description.label")} htmlFor="cc-desc" name="description">
        <Textarea
          id="cc-desc"
          value={description}
          onChange={(e) => onChange(patchParam(params, "description", e.target.value))}
          rows={2}
        />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label={t("avatarColor.label")} htmlFor="cc-color" name="avatarColor">
          <Input
            id="cc-color"
            value={avatarColor}
            onChange={(e) => onChange(patchParam(params, "avatarColor", e.target.value))}
            placeholder={t("avatarColor.placeholder")}
          />
        </Field>
        <Field label={t("avatarEmoji.label")} htmlFor="cc-emoji" name="avatarEmoji">
          <Input
            id="cc-emoji"
            value={avatarEmoji}
            onChange={(e) => onChange(patchParam(params, "avatarEmoji", e.target.value))}
            placeholder={t("avatarEmoji.placeholder")}
          />
        </Field>
        <Field label={t("model.label")} htmlFor="cc-model" name="model">
          <Input
            id="cc-model"
            value={model}
            onChange={(e) => onChange(patchParam(params, "model", e.target.value))}
            placeholder={t("model.placeholder")}
          />
        </Field>
      </div>
    </FieldGroup>
  )
}

// ── action.character.update ───────────────────────────────────────────────
export function CharacterUpdateConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.characterUpdate")
  const characterId = readString(params, "characterId")
  const patchJson = readString(params, "patchJson")
  return (
    <FieldGroup>
      <Field label={t("characterId.label")} htmlFor="cu-char" name="characterId" required>
        <CharacterPicker
          id="cu-char"
          value={characterId}
          onChange={(v) => {
            const next = patchParam(params, "characterId", v) as Record<string, unknown>
            onChange(next)
          }}
        />
      </Field>
      <Field
        label={t("patchJson.label")}
        htmlFor="cu-patch"
        hint={t("patchJson.hint")}
        name="patchJson"
      >
        <Textarea
          id="cu-patch"
          value={patchJson}
          onChange={(e) => {
            const next = patchParam(params, "patchJson", e.target.value) as Record<string, unknown>
            try {
              const parsed = JSON.parse(e.target.value)
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                ;(next as Record<string, unknown>).patch = parsed
              }
            } catch {
              // ignore parse errors during typing — `patch` stays whatever it was
            }
            onChange(next)
          }}
          rows={6}
          className="font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.team.create ────────────────────────────────────────────────────
export function TeamCreateConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.teamCreate")
  const name = readString(params, "name")
  const description = readString(params, "description")
  const orchestration = readString(params, "orchestration", "round_robin")
  const supervisorCharacterId = readString(params, "supervisorCharacterId")
  const membersJson = readString(params, "membersJson", "[]")
  return (
    <FieldGroup>
      <Field label={t("name.label")} htmlFor="tc-name" name="name" required>
        <Input
          id="tc-name"
          value={name}
          onChange={(e) => onChange(patchParam(params, "name", e.target.value))}
        />
      </Field>
      <Field label={t("description.label")} htmlFor="tc-desc" name="description">
        <Textarea
          id="tc-desc"
          value={description}
          onChange={(e) => onChange(patchParam(params, "description", e.target.value))}
          rows={2}
        />
      </Field>
      <Field label={t("orchestration.label")} htmlFor="tc-orc" name="orchestration">
        <Select
          value={orchestration}
          onValueChange={(v) => onChange(patchParam(params, "orchestration", v))}
        >
          <SelectTrigger id="tc-orc">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="round_robin">{t("orchestration.options.round_robin")}</SelectItem>
            <SelectItem value="supervisor">{t("orchestration.options.supervisor")}</SelectItem>
            <SelectItem value="mention_round_robin">
              {t("orchestration.options.mention_round_robin")}
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {orchestration === "supervisor" ? (
        <Field label={t("supervisor.label")} htmlFor="tc-sup" name="supervisorCharacterId">
          <CharacterPicker
            id="tc-sup"
            value={supervisorCharacterId}
            onChange={(v) => onChange(patchParam(params, "supervisorCharacterId", v))}
          />
        </Field>
      ) : null}
      <Field
        label={t("members.label")}
        htmlFor="tc-members"
        hint={t("members.hint")}
        name="membersJson"
      >
        <Textarea
          id="tc-members"
          value={membersJson}
          onChange={(e) => {
            const next = patchParam(params, "membersJson", e.target.value) as Record<
              string,
              unknown
            >
            try {
              const parsed = JSON.parse(e.target.value)
              if (Array.isArray(parsed)) (next as Record<string, unknown>).members = parsed
            } catch {
              // ignore
            }
            onChange(next)
          }}
          rows={5}
          className="font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.team.update ────────────────────────────────────────────────────
export function TeamUpdateConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.teamUpdate")
  const teamId = readString(params, "teamId")
  const patchJson = readString(params, "patchJson")
  return (
    <FieldGroup>
      <Field label={t("teamId.label")} htmlFor="tu-team" name="teamId" required>
        <TeamPicker
          id="tu-team"
          value={teamId}
          onChange={(v) => onChange(patchParam(params, "teamId", v))}
        />
      </Field>
      <Field
        label={t("patchJson.label")}
        htmlFor="tu-patch"
        hint={t("patchJson.hint")}
        name="patchJson"
      >
        <Textarea
          id="tu-patch"
          value={patchJson}
          onChange={(e) => {
            const next = patchParam(params, "patchJson", e.target.value) as Record<string, unknown>
            try {
              const parsed = JSON.parse(e.target.value)
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                ;(next as Record<string, unknown>).patch = parsed
              }
            } catch {
              // ignore
            }
            onChange(next)
          }}
          rows={5}
          className="font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.skill.upsert ───────────────────────────────────────────────────
export function SkillUpsertConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.skillUpsert")
  const skillId = readString(params, "skillId")
  const name = readString(params, "name")
  const description = readString(params, "description")
  const content = readString(params, "content")
  const tagsRaw = readString(params, "tagsRaw")
  return (
    <FieldGroup>
      <Field label={t("skillId.label")} htmlFor="su-id" hint={t("skillId.hint")} name="skillId">
        <SkillPicker
          id="su-id"
          value={skillId}
          onChange={(v) => onChange(patchParam(params, "skillId", v))}
          allowEmpty
        />
      </Field>
      <Field label={t("name.label")} htmlFor="su-name" name="name" required>
        <Input
          id="su-name"
          value={name}
          onChange={(e) => onChange(patchParam(params, "name", e.target.value))}
          placeholder={t("name.placeholder")}
        />
      </Field>
      <Field label={t("description.label")} htmlFor="su-desc" name="description">
        <Input
          id="su-desc"
          value={description}
          onChange={(e) => onChange(patchParam(params, "description", e.target.value))}
        />
      </Field>
      <Field
        label={t("content.label")}
        htmlFor="su-content"
        hint={t("content.hint")}
        name="content"
        required
      >
        <Textarea
          id="su-content"
          value={content}
          onChange={(e) => onChange(patchParam(params, "content", e.target.value))}
          rows={8}
          className="font-mono text-xs"
        />
      </Field>
      <Field label={t("tagsRaw.label")} htmlFor="su-tags" hint={t("tagsRaw.hint")} name="tagsRaw">
        <Input
          id="su-tags"
          value={tagsRaw}
          onChange={(e) => {
            const next = patchParam(params, "tagsRaw", e.target.value) as Record<string, unknown>
            ;(next as Record<string, unknown>).tags = e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
            onChange(next)
          }}
          placeholder={t("tagsRaw.placeholder")}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.twin.ingest ────────────────────────────────────────────────────
export function TwinIngestConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.twinIngest")
  const twinId = readString(params, "twinId")
  const sourceMode = readString(params, "sourceMode", "paste")
  const format = readString(params, "format", "markdown")
  const content = readString(params, "content")
  const url = readString(params, "url")
  const title = readString(params, "title")
  return (
    <FieldGroup>
      <Field label={t("twinId.label")} htmlFor="ti-twin" name="twinId" required>
        <TwinPicker
          id="ti-twin"
          value={twinId}
          onChange={(v) => onChange(patchParam(params, "twinId", v))}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("sourceMode.label")} htmlFor="ti-mode" name="sourceMode">
          <Select
            value={sourceMode}
            onValueChange={(v) => onChange(patchParam(params, "sourceMode", v))}
          >
            <SelectTrigger id="ti-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="paste">{t("sourceMode.options.paste")}</SelectItem>
              <SelectItem value="fetch">{t("sourceMode.options.fetch")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("format.label")} htmlFor="ti-fmt" name="format">
          <Select value={format} onValueChange={(v) => onChange(patchParam(params, "format", v))}>
            <SelectTrigger id="ti-fmt">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="markdown">{t("format.options.markdown")}</SelectItem>
              <SelectItem value="text">{t("format.options.text")}</SelectItem>
              <SelectItem value="code">{t("format.options.code")}</SelectItem>
              <SelectItem value="chat">{t("format.options.chat")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field label={t("title.label")} htmlFor="ti-title" name="title">
        <Input
          id="ti-title"
          value={title}
          onChange={(e) => onChange(patchParam(params, "title", e.target.value))}
        />
      </Field>
      {sourceMode === "fetch" ? (
        <Field label={t("url.label")} htmlFor="ti-url" hint={t("url.hint")} name="url" required>
          <Input
            id="ti-url"
            value={url}
            onChange={(e) => onChange(patchParam(params, "url", e.target.value))}
            placeholder={t("url.placeholder")}
          />
        </Field>
      ) : (
        <Field
          label={t("content.label")}
          htmlFor="ti-content"
          hint={t("content.hint")}
          name="content"
          required
        >
          <Textarea
            id="ti-content"
            value={content}
            onChange={(e) => onChange(patchParam(params, "content", e.target.value))}
            rows={8}
            className="font-mono text-xs"
          />
        </Field>
      )}
    </FieldGroup>
  )
}

// ── action.memory.recall ──────────────────────────────────────────────────
export function MemoryRecallConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.memoryRecall")
  const query = readString(params, "query")
  const scope = readString(params, "scope", "global")
  const characterId = readString(params, "characterId")
  const topK = readNumber(params, "topK", 6)
  return (
    <FieldGroup>
      <Field label={t("query.label")} htmlFor="mr-query" name="query" required>
        <ExpressionField
          id="mr-query"
          value={query}
          onChange={(v) => onChange(patchParam(params, "query", v))}
          multiline
          rows={2}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("scope.label")} htmlFor="mr-scope" name="scope">
          <Select value={scope} onValueChange={(v) => onChange(patchParam(params, "scope", v))}>
            <SelectTrigger id="mr-scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="global">{t("scope.global")}</SelectItem>
              <SelectItem value="character">{t("scope.character")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("topK.label")} htmlFor="mr-topk" name="topK">
          <Input
            id="mr-topk"
            type="number"
            min={1}
            max={50}
            value={topK}
            onChange={(e) => onChange(patchParam(params, "topK", Number(e.target.value) || 1))}
          />
        </Field>
      </div>
      {scope === "character" ? (
        <Field label={t("characterId.label")} htmlFor="mr-char" name="characterId" required>
          <CharacterPicker
            id="mr-char"
            value={characterId}
            onChange={(v) => onChange(patchParam(params, "characterId", v))}
          />
        </Field>
      ) : null}
    </FieldGroup>
  )
}

// ── action.memory.store ───────────────────────────────────────────────────
export function MemoryStoreConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.memoryStore")
  const text = readString(params, "text")
  const scope = readString(params, "scope", "global")
  const characterId = readString(params, "characterId")
  const importance = readNumber(params, "importance", 7)
  const piiGate = readString(params, "piiGate", "block")
  return (
    <FieldGroup>
      <Field label={t("text.label")} htmlFor="ms-text" hint={t("text.hint")} name="text" required>
        <ExpressionField
          id="ms-text"
          value={text}
          onChange={(v) => onChange(patchParam(params, "text", v))}
          multiline
          rows={3}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("scope.label")} htmlFor="ms-scope" name="scope">
          <Select value={scope} onValueChange={(v) => onChange(patchParam(params, "scope", v))}>
            <SelectTrigger id="ms-scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="global">{t("scope.global")}</SelectItem>
              <SelectItem value="character">{t("scope.character")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field
          label={t("importance.label")}
          htmlFor="ms-imp"
          hint={t("importance.hint")}
          name="importance"
        >
          <Input
            id="ms-imp"
            type="number"
            min={1}
            max={10}
            value={importance}
            onChange={(e) =>
              onChange(patchParam(params, "importance", Number(e.target.value) || 1))
            }
          />
        </Field>
      </div>
      {scope === "character" ? (
        <Field label={t("characterId.label")} htmlFor="ms-char" name="characterId" required>
          <CharacterPicker
            id="ms-char"
            value={characterId}
            onChange={(v) => onChange(patchParam(params, "characterId", v))}
          />
        </Field>
      ) : null}
      <Field label={t("piiGate.label")} htmlFor="ms-pii" hint={t("piiGate.hint")} name="piiGate">
        <Select value={piiGate} onValueChange={(v) => onChange(patchParam(params, "piiGate", v))}>
          <SelectTrigger id="ms-pii">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="block">{t("piiGate.block")}</SelectItem>
            <SelectItem value="redact">{t("piiGate.redact")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </FieldGroup>
  )
}

// ── action.mcp.invokeTool ─────────────────────────────────────────────────
export function McpInvokeToolConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.mcpInvokeTool")
  const serverId = readString(params, "serverId")
  const toolName = readString(params, "toolName")
  const argsJson = readString(params, "argsJson", "{}")
  return (
    <FieldGroup>
      <Field label={t("serverId.label")} htmlFor="mi-server" name="serverId" required>
        <McpServerPicker
          id="mi-server"
          value={serverId}
          onChange={(v) => onChange(patchParam(params, "serverId", v))}
        />
      </Field>
      <Field label={t("toolName.label")} htmlFor="mi-tool" name="toolName" required>
        <McpToolPicker
          id="mi-tool"
          serverId={serverId}
          value={toolName}
          onChange={(v) => onChange(patchParam(params, "toolName", v))}
        />
      </Field>
      <Field
        label={t("argsJson.label")}
        htmlFor="mi-args"
        hint={t("argsJson.hint")}
        name="argsJson"
      >
        <Textarea
          id="mi-args"
          value={argsJson}
          onChange={(e) => {
            const next = patchParam(params, "argsJson", e.target.value) as Record<string, unknown>
            try {
              const parsed = JSON.parse(e.target.value)
              if (parsed && typeof parsed === "object") {
                ;(next as Record<string, unknown>).args = parsed
              }
            } catch {
              // ignore
            }
            onChange(next)
          }}
          rows={5}
          className="font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.plugin.invoke ──────────────────────────────────────────────────
// Two dispatch modes mirroring the executor (`lib/workflow/nodes/built-ins.ts`):
//  - "tool": pick an enabled plugin + one of its registered agent tools from
//    dropdowns fed by the capability enumeration API.
//  - "task": legacy free-text `workflow.task` id (ADR-0017 back-compat).
export function PluginInvokeConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.pluginInvoke")
  const pluginId = readString(params, "pluginId")
  const toolName = readString(params, "toolName")
  const taskId = readString(params, "taskId")
  const argsJson = readString(params, "argsJson", "{}")
  // Mode inference mirrors the executor: explicit discriminator wins, then
  // whichever target field a persisted node carries; new nodes default to
  // the tool path.
  const storedMode = readString(params, "mode")
  const mode =
    storedMode === "task" || storedMode === "tool"
      ? storedMode
      : toolName
        ? "tool"
        : taskId
          ? "task"
          : "tool"

  // Capability snapshot for the tool-mode dropdowns. Re-fetched whenever the
  // plugin runtime store mutates (enable/disable/tool registration).
  const [capabilities, setCapabilities] = useState<PluginCapabilities[]>([])
  const pluginsRevision = usePluginStore((s) => s.plugins)
  useEffect(() => {
    if (mode !== "tool") return
    let cancelled = false
    import("@/lib/plugin/api/plugin-capability-registry")
      .then(({ listPluginCapabilities }) => listPluginCapabilities())
      .then((all) => {
        if (!cancelled) setCapabilities(all)
      })
      .catch(() => {
        // Capability sources unavailable (early boot) — pickers stay empty.
      })
    return () => {
      cancelled = true
    }
  }, [mode, pluginsRevision])

  const pluginOptions = capabilities
    .filter((c) => c.enabled && c.tools.length > 0)
    .map((c) => ({ value: c.pluginId, label: c.pluginId }))
  const selectedTools = capabilities.find((c) => c.pluginId === pluginId)?.tools ?? []
  const toolOptions = selectedTools.map((tool) => ({ value: tool.id, label: tool.label }))
  const selectedToolSchema = selectedTools.find((tool) => tool.id === toolName)?.argsSchema
  const schemaFields =
    selectedToolSchema && typeof selectedToolSchema.properties === "object"
      ? Object.keys(selectedToolSchema.properties as Record<string, unknown>)
      : []

  return (
    <FieldGroup>
      <Field label={t("mode.label")} htmlFor="pi-mode" name="mode">
        <Select value={mode} onValueChange={(v) => onChange(patchParam(params, "mode", v))}>
          <SelectTrigger id="pi-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="tool">{t("mode.options.tool")}</SelectItem>
            <SelectItem value="task">{t("mode.options.task")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label={t("pluginId.label")} htmlFor="pi-plug" name="pluginId" required>
        {mode === "tool" ? (
          <EntityPicker
            id="pi-plug"
            value={pluginId}
            onChange={(v) => onChange(patchParam(params, "pluginId", v))}
            options={pluginOptions}
            placeholder={t("pluginId.toolPlaceholder")}
            allowExpression
          />
        ) : (
          <PluginPicker
            id="pi-plug"
            value={pluginId}
            onChange={(v) => onChange(patchParam(params, "pluginId", v))}
          />
        )}
      </Field>
      {mode === "tool" ? (
        <Field label={t("toolName.label")} htmlFor="pi-tool" name="toolName" required>
          <EntityPicker
            id="pi-tool"
            value={toolName}
            onChange={(v) => onChange(patchParam(params, "toolName", v))}
            options={toolOptions}
            placeholder={pluginId ? t("toolName.placeholder") : t("toolName.empty")}
            allowExpression
          />
        </Field>
      ) : (
        <Field label={t("taskId.label")} htmlFor="pi-task" name="taskId" required>
          <Input
            id="pi-task"
            value={taskId}
            onChange={(e) => onChange(patchParam(params, "taskId", e.target.value))}
            placeholder={t("taskId.placeholder")}
          />
        </Field>
      )}
      <Field
        label={t("argsJson.label")}
        htmlFor="pi-args"
        hint={
          mode === "tool" && schemaFields.length > 0
            ? t("argsJson.toolHint", { fields: schemaFields.join(", ") })
            : t("argsJson.hint")
        }
        name="argsJson"
      >
        <Textarea
          id="pi-args"
          value={argsJson}
          onChange={(e) => {
            const next = patchParam(params, "argsJson", e.target.value) as Record<string, unknown>
            try {
              const parsed = JSON.parse(e.target.value)
              if (parsed && typeof parsed === "object") {
                ;(next as Record<string, unknown>).args = parsed
              }
            } catch {
              // ignore
            }
            onChange(next)
          }}
          rows={5}
          className="font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.connector.draft ────────────────────────────────────────────────
export function ConnectorDraftConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.connectorDraft")
  const conversationKey = readString(params, "conversationKey")
  const sessionId = readString(params, "sessionId")
  const content = readString(params, "content")
  const sourceMessageId = readString(params, "sourceMessageId")
  const ttlMs = readNumber(params, "ttlMs", 0)
  return (
    <FieldGroup>
      <Field label={t("conversationKey.label")} htmlFor="cd-conv" name="conversationKey" required>
        <Input
          id="cd-conv"
          value={conversationKey}
          onChange={(e) => onChange(patchParam(params, "conversationKey", e.target.value))}
        />
      </Field>
      <Field label={t("sessionId.label")} htmlFor="cd-session" name="sessionId" required>
        <Input
          id="cd-session"
          value={sessionId}
          onChange={(e) => onChange(patchParam(params, "sessionId", e.target.value))}
        />
      </Field>
      <Field label={t("content.label")} htmlFor="cd-content" name="content" required>
        <Textarea
          id="cd-content"
          value={content}
          onChange={(e) => onChange(patchParam(params, "content", e.target.value))}
          rows={4}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("sourceMessageId.label")} htmlFor="cd-src" name="sourceMessageId">
          <Input
            id="cd-src"
            value={sourceMessageId}
            onChange={(e) => onChange(patchParam(params, "sourceMessageId", e.target.value))}
          />
        </Field>
        <Field label={t("ttlMs.label")} htmlFor="cd-ttl" hint={t("ttlMs.hint")} name="ttlMs">
          <Input
            id="cd-ttl"
            type="number"
            min={0}
            value={ttlMs}
            onChange={(e) => onChange(patchParam(params, "ttlMs", Number(e.target.value) || 0))}
          />
        </Field>
      </div>
    </FieldGroup>
  )
}

// ── ai.classify ───────────────────────────────────────────────────────────
export function AiClassifyConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.aiClassify")
  const provider = readString(params, "provider")
  const model = readString(params, "model")
  const apiKey = readString(params, "apiKey")
  const baseURL = readString(params, "baseURL")
  const input = readString(params, "input")
  const labelsRaw = readString(params, "labelsRaw")
  const hint = readString(params, "hint")
  return (
    <FieldGroup>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("provider.label")} htmlFor="ac-provider" name="provider">
          <Select
            value={provider || undefined}
            onValueChange={(v) => onChange(patchParam(params, "provider", v))}
          >
            <SelectTrigger id="ac-provider">
              <SelectValue placeholder={t("provider.placeholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="anthropic">Anthropic</SelectItem>
              <SelectItem value="openai">OpenAI</SelectItem>
              <SelectItem value="google">Google</SelectItem>
              <SelectItem value="mistral">Mistral</SelectItem>
              <SelectItem value="cohere">Cohere</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("model.label")} htmlFor="ac-model" name="model">
          <Input
            id="ac-model"
            value={model}
            onChange={(e) => onChange(patchParam(params, "model", e.target.value))}
            placeholder={t("model.placeholder")}
          />
        </Field>
      </div>
      <Field label={t("apiKey.label")} htmlFor="ac-key" name="apiKey">
        <Input
          id="ac-key"
          type="password"
          value={apiKey}
          onChange={(e) => onChange(patchParam(params, "apiKey", e.target.value))}
        />
      </Field>
      <Field label={t("baseURL.label")} htmlFor="ac-base" name="baseURL">
        <Input
          id="ac-base"
          value={baseURL}
          onChange={(e) => onChange(patchParam(params, "baseURL", e.target.value))}
        />
      </Field>
      <Field
        label={t("labelsRaw.label")}
        htmlFor="ac-labels"
        hint={t("labelsRaw.hint")}
        name="labelsRaw"
        required
      >
        <Input
          id="ac-labels"
          value={labelsRaw}
          onChange={(e) => {
            const next = patchParam(params, "labelsRaw", e.target.value) as Record<string, unknown>
            ;(next as Record<string, unknown>).labels = e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
            onChange(next)
          }}
          placeholder={t("labelsRaw.placeholder")}
        />
      </Field>
      <Field
        label={t("input.label")}
        htmlFor="ac-input"
        hint={t("input.hint")}
        name="input"
        required
      >
        <Textarea
          id="ac-input"
          value={input}
          onChange={(e) => onChange(patchParam(params, "input", e.target.value))}
          rows={4}
        />
      </Field>
      <Field label={t("hint.label")} htmlFor="ac-hint" name="hint">
        <Input
          id="ac-hint"
          value={hint}
          onChange={(e) => onChange(patchParam(params, "hint", e.target.value))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── ai.extract ────────────────────────────────────────────────────────────
export function AiExtractConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.aiExtract")
  const provider = readString(params, "provider")
  const model = readString(params, "model")
  const apiKey = readString(params, "apiKey")
  const baseURL = readString(params, "baseURL")
  const input = readString(params, "input")
  const schemaJson = readString(params, "schemaJson", "{}")
  const hint = readString(params, "hint")
  const requiredStr = Array.isArray(params.required) ? (params.required as string[]).join(", ") : ""
  return (
    <FieldGroup>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("provider.label")} htmlFor="ae-provider" name="provider">
          <Select
            value={provider || undefined}
            onValueChange={(v) => onChange(patchParam(params, "provider", v))}
          >
            <SelectTrigger id="ae-provider">
              <SelectValue placeholder={t("provider.placeholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="anthropic">Anthropic</SelectItem>
              <SelectItem value="openai">OpenAI</SelectItem>
              <SelectItem value="google">Google</SelectItem>
              <SelectItem value="mistral">Mistral</SelectItem>
              <SelectItem value="cohere">Cohere</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("model.label")} htmlFor="ae-model" name="model">
          <Input
            id="ae-model"
            value={model}
            onChange={(e) => onChange(patchParam(params, "model", e.target.value))}
          />
        </Field>
      </div>
      <Field label={t("apiKey.label")} htmlFor="ae-key" name="apiKey">
        <Input
          id="ae-key"
          type="password"
          value={apiKey}
          onChange={(e) => onChange(patchParam(params, "apiKey", e.target.value))}
        />
      </Field>
      <Field label={t("baseURL.label")} htmlFor="ae-base" name="baseURL">
        <Input
          id="ae-base"
          value={baseURL}
          onChange={(e) => onChange(patchParam(params, "baseURL", e.target.value))}
        />
      </Field>
      <Field
        label={t("schemaJson.label")}
        htmlFor="ae-schema"
        hint={t("schemaJson.hint")}
        name="schemaJson"
      >
        <Textarea
          id="ae-schema"
          value={schemaJson}
          onChange={(e) => {
            const next = patchParam(params, "schemaJson", e.target.value) as Record<string, unknown>
            try {
              const parsed = JSON.parse(e.target.value)
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                ;(next as Record<string, unknown>).schema = parsed
              }
            } catch {
              // ignore
            }
            onChange(next)
          }}
          rows={5}
          className="font-mono text-xs"
        />
      </Field>
      <Field label={t("input.label")} htmlFor="ae-input" name="input" required>
        <Textarea
          id="ae-input"
          value={input}
          onChange={(e) => onChange(patchParam(params, "input", e.target.value))}
          rows={4}
        />
      </Field>
      <Field
        label={t("required.label")}
        htmlFor="ae-required"
        hint={t("required.hint")}
        name="required"
      >
        <Input
          id="ae-required"
          value={requiredStr}
          placeholder={t("required.placeholder")}
          onChange={(e) =>
            onChange(
              patchParam(
                params,
                "required",
                e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              )
            )
          }
        />
      </Field>
      <Field label={t("hint.label")} htmlFor="ae-hint" name="hint">
        <Input
          id="ae-hint"
          value={hint}
          onChange={(e) => onChange(patchParam(params, "hint", e.target.value))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── ai.embed ──────────────────────────────────────────────────────────────
export function AiEmbedConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.aiEmbed")
  const input = readString(params, "input")
  const dimension = readNumber(params, "dimension", 384)
  const provider = readString(params, "provider")
  const model = readString(params, "model")
  const apiKey = readString(params, "apiKey")
  return (
    <FieldGroup>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("provider.label")} htmlFor="aem-provider" name="provider">
          <Select
            value={provider || undefined}
            onValueChange={(v) => onChange(patchParam(params, "provider", v))}
          >
            <SelectTrigger id="aem-provider">
              <SelectValue placeholder={t("provider.placeholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openai">OpenAI</SelectItem>
              <SelectItem value="google">Google</SelectItem>
              <SelectItem value="cohere">Cohere</SelectItem>
              <SelectItem value="mistral">Mistral</SelectItem>
              <SelectItem value="transformersjs">Transformers.js (local)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("model.label")} htmlFor="aem-model" hint={t("model.hint")} name="model">
          <Input
            id="aem-model"
            value={model}
            onChange={(e) => onChange(patchParam(params, "model", e.target.value))}
            placeholder={t("model.placeholder")}
          />
        </Field>
      </div>
      <Field label={t("apiKey.label")} htmlFor="aem-key" hint={t("apiKey.hint")} name="apiKey">
        <Input
          id="aem-key"
          type="password"
          value={apiKey}
          onChange={(e) => onChange(patchParam(params, "apiKey", e.target.value))}
        />
      </Field>
      <Field
        label={t("input.label")}
        htmlFor="aem-input"
        hint={t("input.hint")}
        name="input"
        required
      >
        <Textarea
          id="aem-input"
          value={input}
          onChange={(e) => onChange(patchParam(params, "input", e.target.value))}
          rows={4}
        />
      </Field>
      <Field
        label={t("dimension.label")}
        htmlFor="aem-dim"
        hint={t("dimension.hint")}
        name="dimension"
      >
        <Input
          id="aem-dim"
          type="number"
          min={32}
          max={4096}
          value={dimension}
          onChange={(e) => onChange(patchParam(params, "dimension", Number(e.target.value) || 384))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── flow.switch ───────────────────────────────────────────────────────────
export function SwitchConfig({ params, onChange, typeVersion }: ConfigProps) {
  if ((typeVersion ?? 1) >= 2) {
    return <SwitchConfigV2 params={params} onChange={onChange} />
  }
  return <SwitchConfigV1 params={params} onChange={onChange} />
}

interface SwitchCaseV2 {
  id: string
  label?: string
  when: WorkflowConditionGroup
}

/** typeVersion 2 — ordered cases, each with a stable id + condition group. */
function SwitchConfigV2({ params, onChange }: { params: Params; onChange: ChangeFn }) {
  const t = useTranslations("workflows.forms.switchV2")
  const tBuilder = useTranslations("workflows.forms.conditionBuilder")
  const cases = Array.isArray(params.cases) ? (params.cases as SwitchCaseV2[]) : []

  function updateCases(next: SwitchCaseV2[]) {
    onChange(patchParam(params, "cases", next))
  }

  return (
    <FieldGroup>
      <Field
        label={t("cases.label")}
        htmlFor="swv2-cases"
        hint={t("cases.hint")}
        name="cases"
        required
      >
        <div className="space-y-3">
          {cases.map((c, i) => (
            <div key={c.id || i} className="space-y-2 rounded-md border p-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("cases.caseTitle", { index: i + 1 })}
                </span>
                <Input
                  value={c.label ?? ""}
                  onChange={(e) => {
                    const next = [...cases]
                    next[i] = { ...c, label: e.target.value }
                    updateCases(next)
                  }}
                  placeholder={t("cases.caseLabelPlaceholder")}
                  data-testid={`switch-v2-case-label-${i}`}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() => updateCases(cases.filter((_, j) => j !== i))}
                  aria-label={t("cases.removeCase")}
                  data-testid={`switch-v2-remove-case-${i}`}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              <ConditionBuilder
                idPrefix={`switch-case-${i}`}
                value={c.when}
                onChange={(when) => {
                  const next = [...cases]
                  next[i] = { ...c, when }
                  updateCases(next)
                }}
              />
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              updateCases([
                ...cases,
                {
                  // Stable routing id — survives label renames so edges and
                  // run decisions never silently re-route.
                  id: "c_" + Math.random().toString(36).slice(2, 8),
                  label: "",
                  when: { combinator: "all", conditions: [] },
                },
              ])
            }
            data-testid="switch-v2-add-case"
          >
            <Plus className="size-3.5 mr-1" /> {t("cases.addCase")}
          </Button>
        </div>
      </Field>
      <p className="text-[11px] text-muted-foreground">{tBuilder("coercionHint")}</p>
    </FieldGroup>
  )
}

function SwitchConfigV1({ params, onChange }: { params: Params; onChange: ChangeFn }) {
  const t = useTranslations("workflows.forms.switch")
  const subject = readString(params, "subject")
  const cases = Array.isArray(params.cases)
    ? (params.cases as Array<{ value: unknown; label: string }>)
    : []
  const defaultLabel = readString(params, "defaultLabel", "default")

  function updateCases(next: Array<{ value: unknown; label: string }>) {
    onChange(patchParam(params, "cases", next))
  }

  return (
    <FieldGroup>
      <Field
        label={t("subject.label")}
        htmlFor="sw-subject"
        hint={t("subject.hint")}
        name="subject"
        required
      >
        <Textarea
          id="sw-subject"
          value={subject}
          onChange={(e) => onChange(patchParam(params, "subject", e.target.value))}
          rows={2}
          className="font-mono text-xs"
          placeholder={t("subject.placeholder")}
        />
      </Field>
      <Field
        label={t("cases.label")}
        htmlFor="sw-cases"
        hint={t("cases.hint")}
        name="cases"
        required
      >
        <div className="space-y-2">
          {cases.map((c, i) => (
            <div key={i} className="flex gap-2 items-start">
              <Input
                value={typeof c.value === "string" ? c.value : JSON.stringify(c.value)}
                onChange={(e) => {
                  const next = [...cases]
                  next[i] = { ...c, value: e.target.value }
                  updateCases(next)
                }}
                placeholder={t("cases.valuePlaceholder")}
              />
              <Input
                value={c.label}
                onChange={(e) => {
                  const next = [...cases]
                  next[i] = { ...c, label: e.target.value }
                  updateCases(next)
                }}
                placeholder={t("cases.labelPlaceholder")}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => updateCases(cases.filter((_, j) => j !== i))}
                aria-label={t("cases.removeCase")}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => updateCases([...cases, { value: "", label: "" }])}
          >
            <Plus className="size-3.5 mr-1" /> {t("cases.addCase")}
          </Button>
        </div>
      </Field>
      <Field label={t("defaultLabel.label")} htmlFor="sw-default" name="defaultLabel">
        <Input
          id="sw-default"
          value={defaultLabel}
          onChange={(e) => onChange(patchParam(params, "defaultLabel", e.target.value))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── flow.split ────────────────────────────────────────────────────────────
export function SplitConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.split")
  const labels = Array.isArray(params.branchLabels) ? (params.branchLabels as string[]) : ["A", "B"]

  function updateLabels(next: string[]) {
    onChange(patchParam(params, "branchLabels", next))
  }

  return (
    <FieldGroup>
      <Field
        label={t("branchLabels.label")}
        htmlFor="sp-labels"
        hint={t("branchLabels.hint")}
        name="branchLabels"
        required
      >
        <div className="space-y-2">
          {labels.map((label, i) => (
            <div key={i} className="flex gap-2">
              <Input
                value={label}
                onChange={(e) => {
                  const next = [...labels]
                  next[i] = e.target.value
                  updateLabels(next)
                }}
                placeholder={t("branchLabels.branchPlaceholder", { n: i + 1 })}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => updateLabels(labels.filter((_, j) => j !== i))}
                aria-label={t("branchLabels.removeBranch")}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              updateLabels([
                ...labels,
                t("branchLabels.branchPlaceholder", { n: labels.length + 1 }),
              ])
            }
          >
            <Plus className="size-3.5 mr-1" /> {t("branchLabels.addBranch")}
          </Button>
        </div>
      </Field>
    </FieldGroup>
  )
}

// ── flow.join ─────────────────────────────────────────────────────────────
export function JoinConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.join")
  const joinPolicy = readString(params, "joinPolicy", "all")
  const timeoutMs = readNumber(params, "timeoutMs", 0)
  return (
    <FieldGroup>
      <Field label={t("joinPolicy.label")} htmlFor="jn-policy" name="joinPolicy">
        <Select
          value={joinPolicy}
          onValueChange={(v) => onChange(patchParam(params, "joinPolicy", v))}
        >
          <SelectTrigger id="jn-policy">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("joinPolicy.options.all")}</SelectItem>
            <SelectItem value="any">{t("joinPolicy.options.any")}</SelectItem>
            <SelectItem value="race">{t("joinPolicy.options.race")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("timeoutMs.label")}
        htmlFor="jn-timeout"
        hint={t("timeoutMs.hint")}
        name="timeoutMs"
      >
        <Input
          id="jn-timeout"
          type="number"
          min={0}
          value={timeoutMs}
          onChange={(e) => onChange(patchParam(params, "timeoutMs", Number(e.target.value) || 0))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── flow.loop ─────────────────────────────────────────────────────────────
export function LoopConfig({ params, onChange, typeVersion }: ConfigProps) {
  if ((typeVersion ?? 1) >= 2) {
    return <LoopConfigV2 params={params} onChange={onChange} />
  }
  return <LoopConfigV1 params={params} onChange={onChange} />
}

/** typeVersion 2 — container sub-canvas (body nodes live inside the loop). */
function LoopConfigV2({ params, onChange }: { params: Params; onChange: ChangeFn }) {
  const t = useTranslations("workflows.forms.loopV2")
  const mode = readString(params, "mode", "forEach")
  const source = readString(params, "source")
  // `times` may be a literal number or an expression string.
  const times =
    typeof params.times === "number" ? String(params.times) : readString(params, "times")
  const whileExpression = readString(params, "whileExpression")
  const conditionTiming = readString(params, "conditionTiming", "pre")
  const output = readString(params, "output")
  const iterationConcurrency = readNumber(params, "iterationConcurrency", 1)
  const batchSize = readNumber(params, "batchSize", 0)
  const maxIterations = readNumber(params, "maxIterations", 0)
  const onItemError = readString(params, "onItemError", "fail")
  return (
    <FieldGroup>
      <p className="text-xs text-muted-foreground">{t("intro")}</p>
      <Field label={t("mode.label")} htmlFor="lp2-mode" name="mode">
        <Select
          value={mode}
          onValueChange={(v) => {
            // Drop mode-scoped knobs when leaving their mode — the params
            // schema rejects e.g. a stale conditionTiming on forEach.
            let next = patchParam(params, "mode", v)
            if (v !== "while") next = patchParam(next, "conditionTiming", undefined)
            if (v !== "forEach") next = patchParam(next, "batchSize", undefined)
            onChange(next)
          }}
        >
          <SelectTrigger id="lp2-mode" data-testid="loop-v2-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="forEach">{t("mode.forEach")}</SelectItem>
            <SelectItem value="times">{t("mode.times")}</SelectItem>
            <SelectItem value="while">{t("mode.while")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {mode === "forEach" ? (
        <Field
          label={t("source.label")}
          htmlFor="lp2-source"
          hint={t("source.hint")}
          name="source"
          required
        >
          <ExpressionField
            id="lp2-source"
            value={source}
            onChange={(v) => onChange(patchParam(params, "source", v))}
            placeholder={t("source.placeholder")}
            aria-label={t("source.label")}
          />
        </Field>
      ) : null}
      {mode === "times" ? (
        <Field
          label={t("times.label")}
          htmlFor="lp2-times"
          hint={t("times.hint")}
          name="times"
          required
        >
          <ExpressionField
            id="lp2-times"
            value={times}
            onChange={(v) => onChange(patchParam(params, "times", v))}
            placeholder="10"
            aria-label={t("times.label")}
          />
        </Field>
      ) : null}
      {mode === "while" ? (
        <Field
          label={t("whileExpression.label")}
          htmlFor="lp2-while"
          hint={t("whileExpression.hint")}
          name="whileExpression"
          required
        >
          <ExpressionField
            id="lp2-while"
            value={whileExpression}
            onChange={(v) => onChange(patchParam(params, "whileExpression", v))}
            placeholder={t("whileExpression.placeholder")}
            aria-label={t("whileExpression.label")}
          />
        </Field>
      ) : null}
      {mode === "while" ? (
        <Field
          label={t("conditionTiming.label")}
          htmlFor="lp2-condition-timing"
          hint={t("conditionTiming.hint")}
          name="conditionTiming"
        >
          <Select
            value={conditionTiming}
            onValueChange={(v) =>
              onChange(patchParam(params, "conditionTiming", v === "pre" ? undefined : v))
            }
          >
            <SelectTrigger id="lp2-condition-timing" data-testid="loop-v2-condition-timing">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pre">{t("conditionTiming.pre")}</SelectItem>
              <SelectItem value="post">{t("conditionTiming.post")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      <Field label={t("output.label")} htmlFor="lp2-output" hint={t("output.hint")} name="output">
        <ExpressionField
          id="lp2-output"
          value={output}
          onChange={(v) => onChange(patchParam(params, "output", v))}
          placeholder={t("output.placeholder")}
          aria-label={t("output.label")}
        />
      </Field>
      {mode !== "while" ? (
        <Field
          label={t("iterationConcurrency.label")}
          htmlFor="lp2-conc"
          hint={t("iterationConcurrency.hint")}
          name="iterationConcurrency"
        >
          <Input
            id="lp2-conc"
            type="number"
            min={1}
            max={64}
            value={iterationConcurrency}
            onChange={(e) =>
              onChange(patchParam(params, "iterationConcurrency", Number(e.target.value) || 1))
            }
            data-testid="loop-v2-concurrency"
          />
        </Field>
      ) : null}
      {mode === "forEach" ? (
        <Field
          label={t("batchSize.label")}
          htmlFor="lp2-batch-size"
          hint={t("batchSize.hint")}
          name="batchSize"
        >
          <Input
            id="lp2-batch-size"
            type="number"
            min={1}
            value={batchSize || ""}
            onChange={(e) => {
              const n = Number(e.target.value)
              onChange(patchParam(params, "batchSize", Number.isFinite(n) && n > 0 ? n : undefined))
            }}
            placeholder={t("batchSize.placeholder")}
            data-testid="loop-v2-batch-size"
          />
        </Field>
      ) : null}
      <Field
        label={t("maxIterations.label")}
        htmlFor="lp2-max"
        hint={t("maxIterations.hint")}
        name="maxIterations"
      >
        <Input
          id="lp2-max"
          type="number"
          min={1}
          value={maxIterations || ""}
          onChange={(e) => {
            const n = Number(e.target.value)
            onChange(
              patchParam(params, "maxIterations", Number.isFinite(n) && n > 0 ? n : undefined)
            )
          }}
          placeholder={t("maxIterations.placeholder")}
        />
      </Field>
      <Field
        label={t("onItemError.label")}
        htmlFor="lp2-on-item-error"
        hint={t("onItemError.hint")}
        name="onItemError"
      >
        <Select
          value={onItemError}
          onValueChange={(v) =>
            onChange(patchParam(params, "onItemError", v === "fail" ? undefined : v))
          }
        >
          <SelectTrigger id="lp2-on-item-error" data-testid="loop-v2-on-item-error">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="fail">{t("onItemError.fail")}</SelectItem>
            <SelectItem value="skip">{t("onItemError.skip")}</SelectItem>
            <SelectItem value="break">{t("onItemError.break")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </FieldGroup>
  )
}

// ── flow.break / flow.continue ────────────────────────────────────────────
export function BreakConfig() {
  const t = useTranslations("workflows.forms.loopJump")
  return <p className="text-xs text-muted-foreground">{t("breakIntro")}</p>
}

export function ContinueConfig() {
  const t = useTranslations("workflows.forms.loopJump")
  return <p className="text-xs text-muted-foreground">{t("continueIntro")}</p>
}

function LoopConfigV1({ params, onChange }: { params: Params; onChange: ChangeFn }) {
  const t = useTranslations("workflows.forms.loop")
  const mode = readString(params, "mode", "forEach")
  const times = readNumber(params, "times", 1)
  const inputExpr = readString(params, "inputExpression")
  const bodyExpr = readString(params, "bodyExpression")
  const whileCondition = readString(params, "whileCondition")
  const maxIterations = readNumber(params, "maxIterations", 10000)
  return (
    <FieldGroup>
      <Field label={t("mode.label")} htmlFor="lp-mode" name="mode">
        <Select value={mode} onValueChange={(v) => onChange(patchParam(params, "mode", v))}>
          <SelectTrigger id="lp-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="forEach">{t("mode.options.forEach")}</SelectItem>
            <SelectItem value="times">{t("mode.options.times")}</SelectItem>
            <SelectItem value="while">{t("mode.options.while")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {mode === "times" ? (
        <Field label={t("times.label")} htmlFor="lp-times" name="times" required>
          <Input
            id="lp-times"
            type="number"
            min={0}
            value={times}
            onChange={(e) => onChange(patchParam(params, "times", Number(e.target.value) || 0))}
          />
        </Field>
      ) : null}
      {mode === "forEach" ? (
        <Field
          label={t("inputExpression.label")}
          htmlFor="lp-input"
          hint={t("inputExpression.hint")}
          name="inputExpression"
          required
        >
          <Textarea
            id="lp-input"
            value={inputExpr}
            onChange={(e) => onChange(patchParam(params, "inputExpression", e.target.value))}
            rows={2}
            className="font-mono text-xs"
            placeholder={t("inputExpression.placeholder")}
          />
        </Field>
      ) : null}
      {mode === "while" ? (
        <Field
          label={t("whileCondition.label")}
          htmlFor="lp-while"
          hint={t("whileCondition.hint")}
          name="whileCondition"
          required
        >
          <Textarea
            id="lp-while"
            value={whileCondition}
            onChange={(e) => onChange(patchParam(params, "whileCondition", e.target.value))}
            rows={2}
            className="font-mono text-xs"
          />
        </Field>
      ) : null}
      <Field
        label={t("bodyExpression.label")}
        htmlFor="lp-body"
        hint={t("bodyExpression.hint")}
        name="bodyExpression"
        required
      >
        <Textarea
          id="lp-body"
          value={bodyExpr}
          onChange={(e) => onChange(patchParam(params, "bodyExpression", e.target.value))}
          rows={2}
          className="font-mono text-xs"
          placeholder={t("bodyExpression.placeholder")}
        />
      </Field>
      <Field
        label={t("maxIterations.label")}
        htmlFor="lp-max"
        hint={t("maxIterations.hint")}
        name="maxIterations"
      >
        <Input
          id="lp-max"
          type="number"
          min={1}
          max={1000000}
          value={maxIterations}
          onChange={(e) =>
            onChange(patchParam(params, "maxIterations", Number(e.target.value) || 10000))
          }
        />
      </Field>
    </FieldGroup>
  )
}

// ── flow.subworkflow ──────────────────────────────────────────────────────
export function SubworkflowConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.subworkflow")
  const workflowId = readString(params, "workflowId")
  const inputJson = readString(params, "inputJson", "{}")
  return (
    <FieldGroup>
      <Field label={t("workflowId.label")} htmlFor="sw-wf" name="workflowId" required>
        <SubworkflowPicker
          id="sw-wf"
          value={workflowId}
          onChange={(v) => onChange(patchParam(params, "workflowId", v))}
        />
      </Field>
      <Field
        label={t("inputJson.label")}
        htmlFor="sw-input"
        hint={t("inputJson.hint")}
        name="inputJson"
      >
        <Textarea
          id="sw-input"
          value={inputJson}
          onChange={(e) => {
            const next = patchParam(params, "inputJson", e.target.value) as Record<string, unknown>
            try {
              const parsed = JSON.parse(e.target.value)
              ;(next as Record<string, unknown>).input = parsed
            } catch {
              // ignore
            }
            onChange(next)
          }}
          rows={5}
          className="font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  )
}

// ── io.webhook.respond ────────────────────────────────────────────────────
export function WebhookRespondConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.webhookRespond")
  const status = readNumber(params, "status", 200)
  const headersJson = readString(params, "headersJson", "{}")
  const body = readString(params, "body")
  return (
    <FieldGroup>
      <p className="text-[11px] text-wf-status-running">{t("desktopOnly")}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("status.label")} htmlFor="wr-status" name="status">
          <Input
            id="wr-status"
            type="number"
            min={100}
            max={599}
            value={status}
            onChange={(e) => onChange(patchParam(params, "status", Number(e.target.value) || 200))}
          />
        </Field>
        <Field
          label={t("headersJson.label")}
          htmlFor="wr-headers"
          hint={t("headersJson.hint")}
          name="headersJson"
        >
          <Input
            id="wr-headers"
            value={headersJson}
            onChange={(e) => {
              const next = patchParam(params, "headersJson", e.target.value) as Record<
                string,
                unknown
              >
              try {
                const parsed = JSON.parse(e.target.value)
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                  ;(next as Record<string, unknown>).headers = parsed
                }
              } catch {
                // ignore
              }
              onChange(next)
            }}
            placeholder={t("headersJson.placeholder")}
            className="font-mono text-xs"
          />
        </Field>
      </div>
      <Field label={t("body.label")} htmlFor="wr-body" hint={t("body.hint")} name="body">
        <Textarea
          id="wr-body"
          value={body}
          onChange={(e) => onChange(patchParam(params, "body", e.target.value))}
          rows={5}
          className="font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  )
}

// ── annotation.group ──────────────────────────────────────────────────────
export function GroupAnnotationConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.groupAnnotation")
  const title = readString(params, "title")
  const color = readString(params, "color", "zinc")
  const width = readNumber(params, "width", 480)
  const height = readNumber(params, "height", 320)
  return (
    <FieldGroup>
      <Field label={t("title.label")} htmlFor="grp-title" name="title">
        <Input
          id="grp-title"
          value={title}
          onChange={(e) => onChange(patchParam(params, "title", e.target.value))}
          placeholder={t("title.placeholder")}
        />
      </Field>
      <Field label={t("color.label")} htmlFor="grp-color" name="color">
        <Select value={color} onValueChange={(v) => onChange(patchParam(params, "color", v))}>
          <SelectTrigger id="grp-color">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="zinc">{t("color.options.zinc")}</SelectItem>
            <SelectItem value="emerald">{t("color.options.emerald")}</SelectItem>
            <SelectItem value="sky">{t("color.options.sky")}</SelectItem>
            <SelectItem value="violet">{t("color.options.violet")}</SelectItem>
            <SelectItem value="amber">{t("color.options.amber")}</SelectItem>
            <SelectItem value="rose">{t("color.options.rose")}</SelectItem>
            <SelectItem value="cyan">{t("color.options.cyan")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("width.label")} htmlFor="grp-w" name="width">
          <Input
            id="grp-w"
            type="number"
            min={200}
            value={width}
            onChange={(e) => onChange(patchParam(params, "width", Number(e.target.value) || 480))}
          />
        </Field>
        <Field label={t("height.label")} htmlFor="grp-h" name="height">
          <Input
            id="grp-h"
            type="number"
            min={100}
            value={height}
            onChange={(e) => onChange(patchParam(params, "height", Number(e.target.value) || 320))}
          />
        </Field>
      </div>
    </FieldGroup>
  )
}

// ── flow.catch ─────────────────────────────────────────────────────────────
// Terminal-failure recovery entrypoint. Receives the error envelope on
// `{{ $node['id'].error }}`; downstream is the recovery / notify path.
export function CatchConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.catch")
  const scope = readString(params, "scope", "workflow")
  return (
    <FieldGroup>
      <p className="text-xs text-muted-foreground">{t("intro")}</p>
      <Field label={t("scope.label")} htmlFor="catch-scope" name="scope" hint={t("scope.hint")}>
        <Select value={scope} onValueChange={(v) => onChange(patchParam(params, "scope", v))}>
          <SelectTrigger id="catch-scope">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="workflow">{t("scope.options.workflow")}</SelectItem>
            <SelectItem value="upstream">{t("scope.options.upstream")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </FieldGroup>
  )
}

// Entity pickers (Character/Team/Skill/McpServer/Plugin/Subworkflow/Twin) now
// live in `./shared/entity-picker` as searchable comboboxes — imported above.

// ── trigger.team ──────────────────────────────────────────────────────────
// Synthesizer-internal: fired by the agent-team runtime, not hand-authored.
// Informational panel only — params schema is empty (`z.object({})`).
export function TeamTriggerConfig() {
  const t = useTranslations("workflows.forms.teamTrigger")
  return <p className="text-xs text-muted-foreground">{t("intro")}</p>
}

// ── action.team.task.dispatch ─────────────────────────────────────────────
// Synthesizer-emitted dispatch node. Mirrors the executor's input contract in
// `lib/workflow/nodes/built-ins.ts` (teamId/taskId/title/description + optional
// expectedOutput).
export function TeamTaskDispatchConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.teamTaskDispatch")
  const teamId = readString(params, "teamId")
  const taskId = readString(params, "taskId")
  const title = readString(params, "title")
  const description = readString(params, "description")
  const expectedOutput = readString(params, "expectedOutput")
  return (
    <FieldGroup>
      <Field label={t("teamId.label")} htmlFor="ttd-team" name="teamId" required>
        <TeamPicker
          id="ttd-team"
          value={teamId}
          onChange={(v) => onChange(patchParam(params, "teamId", v))}
        />
      </Field>
      <Field
        label={t("taskId.label")}
        htmlFor="ttd-task"
        hint={t("taskId.hint")}
        name="taskId"
        required
      >
        <Input
          id="ttd-task"
          value={taskId}
          onChange={(e) => onChange(patchParam(params, "taskId", e.target.value))}
          placeholder={t("taskId.placeholder")}
        />
      </Field>
      <Field label={t("title.label")} htmlFor="ttd-title" name="title" required>
        <Input
          id="ttd-title"
          value={title}
          onChange={(e) => onChange(patchParam(params, "title", e.target.value))}
          placeholder={t("title.placeholder")}
        />
      </Field>
      <Field label={t("description.label")} htmlFor="ttd-desc" name="description" required>
        <Textarea
          id="ttd-desc"
          rows={3}
          value={description}
          onChange={(e) => onChange(patchParam(params, "description", e.target.value))}
          placeholder={t("description.placeholder")}
        />
      </Field>
      <Field
        label={t("expectedOutput.label")}
        htmlFor="ttd-expected"
        hint={t("expectedOutput.hint")}
        name="expectedOutput"
      >
        <Textarea
          id="ttd-expected"
          rows={2}
          value={expectedOutput}
          onChange={(e) => onChange(patchParam(params, "expectedOutput", e.target.value))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── trigger.desktop.event ─────────────────────────────────────────────────
// Desktop-only. Multi-selects the UIA event kinds the executor reads from
// `params.kinds` (see `lib/automation/types.ts:EventKind`).
const DESKTOP_EVENT_KINDS = ["focus-changed", "structure-changed", "property-changed"] as const

export function DesktopEventTriggerConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.desktopEventTrigger")
  const selected = Array.isArray(params.kinds) ? (params.kinds as string[]) : []
  const toggle = (kind: string) => {
    const next = selected.includes(kind) ? selected.filter((k) => k !== kind) : [...selected, kind]
    onChange(patchParam(params, "kinds", next))
  }
  return (
    <FieldGroup>
      <p className="text-xs text-muted-foreground">{t("desktopOnly")}</p>
      <Field label={t("kinds.label")} hint={t("kinds.hint")} name="kinds">
        <div className="space-y-1.5">
          {DESKTOP_EVENT_KINDS.map((kind) => (
            <label
              key={kind}
              className="flex items-center gap-2 rounded-md border bg-muted/20 px-2 py-1.5 text-sm hover:bg-muted/40"
            >
              <Checkbox
                checked={selected.includes(kind)}
                onCheckedChange={() => toggle(kind)}
                data-testid={`desktop-event-${kind}`}
              />
              <span>{t(`kinds.options.${kind}` as never)}</span>
            </label>
          ))}
        </div>
      </Field>
    </FieldGroup>
  )
}

// ── action.system.terminal ────────────────────────────────────────────────
// Wave 3 — config form for the integrated terminal action. Mirrors the
// executor's input contract in `lib/workflow/nodes/terminal.ts`.
export function SystemTerminalConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.systemTerminal")
  const command = readString(params, "command")
  const cwd = readString(params, "cwd")
  const shell = readString(params, "shell")
  const tabId = readString(params, "tabId")
  const timeoutSec = readNumber(params, "timeoutSec", 60)
  const onFailure = readString(params, "onFailure", "throw")
  const unattended = readBoolean(params, "unattended", false)
  const onAskVerdict = readString(params, "onAskVerdict", "fail")
  return (
    <FieldGroup>
      <Field
        label={t("command.label")}
        htmlFor="term-command"
        hint={t("command.hint")}
        name="command"
        required
      >
        <Textarea
          id="term-command"
          value={command}
          onChange={(e) => onChange(patchParam(params, "command", e.target.value))}
          placeholder={t("command.placeholder")}
          rows={3}
          className="font-mono text-xs"
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("cwd.label")} htmlFor="term-cwd" hint={t("cwd.hint")} name="cwd">
          <Input
            id="term-cwd"
            value={cwd}
            onChange={(e) => onChange(patchParam(params, "cwd", e.target.value))}
            placeholder={t("cwd.placeholder")}
          />
        </Field>
        <Field label={t("shell.label")} htmlFor="term-shell" hint={t("shell.hint")} name="shell">
          <Input
            id="term-shell"
            value={shell}
            onChange={(e) => onChange(patchParam(params, "shell", e.target.value))}
            placeholder={t("shell.placeholder")}
          />
        </Field>
      </div>
      <Field label={t("tabId.label")} htmlFor="term-tab" hint={t("tabId.hint")} name="tabId">
        <Input
          id="term-tab"
          value={tabId}
          onChange={(e) => onChange(patchParam(params, "tabId", e.target.value))}
          placeholder={t("tabId.placeholder")}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field
          label={t("timeoutSec.label")}
          htmlFor="term-timeout"
          hint={t("timeoutSec.hint")}
          name="timeoutSec"
        >
          <Input
            id="term-timeout"
            type="number"
            min={5}
            max={600}
            value={timeoutSec}
            onChange={(e) =>
              onChange(
                patchParam(
                  params,
                  "timeoutSec",
                  Math.max(5, Math.min(600, Number(e.target.value) || 60))
                )
              )
            }
          />
        </Field>
        <Field
          label={t("onFailure.label")}
          htmlFor="term-onfail"
          hint={t("onFailure.hint")}
          name="onFailure"
        >
          <Select
            value={onFailure}
            onValueChange={(v) => onChange(patchParam(params, "onFailure", v))}
          >
            <SelectTrigger id="term-onfail">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="throw">{t("onFailure.options.throw")}</SelectItem>
              <SelectItem value="branch">{t("onFailure.options.branch")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <TerminalUnattendedFields
        params={params}
        onChange={onChange}
        unattended={unattended}
        onAskVerdict={onAskVerdict}
        idPrefix="term"
      />
    </FieldGroup>
  )
}

/**
 * Shared unattended-mode controls (`action.system.terminal` +
 * `action.terminal.session.*`): the headless toggle and, while it is on,
 * the ask-verdict policy. Keys live under `workflows.forms.terminalUnattended`.
 */
function TerminalUnattendedFields({
  params,
  onChange,
  unattended,
  onAskVerdict,
  idPrefix,
}: {
  params: Params
  onChange: ChangeFn
  unattended: boolean
  onAskVerdict: string
  idPrefix: string
}) {
  const t = useTranslations("workflows.forms.terminalUnattended")
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <Field
          label={t("unattended.label")}
          htmlFor={`${idPrefix}-unattended`}
          hint={t("unattended.hint")}
          name="unattended"
        >
          <Switch
            id={`${idPrefix}-unattended`}
            checked={unattended}
            onCheckedChange={(v) => onChange(patchParam(params, "unattended", v))}
          />
        </Field>
      </div>
      {unattended ? (
        <Field
          label={t("onAskVerdict.label")}
          htmlFor={`${idPrefix}-askverdict`}
          hint={t("onAskVerdict.hint")}
          name="onAskVerdict"
        >
          <Select
            value={onAskVerdict}
            onValueChange={(v) => onChange(patchParam(params, "onAskVerdict", v))}
          >
            <SelectTrigger id={`${idPrefix}-askverdict`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fail">{t("onAskVerdict.options.fail")}</SelectItem>
              <SelectItem value="consent">{t("onAskVerdict.options.consent")}</SelectItem>
              <SelectItem value="run">{t("onAskVerdict.options.run")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      ) : null}
    </>
  )
}

// ── action.terminal.session.* ───────────────────────────────────────────────
export function TerminalSessionOpenConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.terminalSessionOpen")
  const cwd = readString(params, "cwd")
  const shell = readString(params, "shell")
  const unattended = readBoolean(params, "unattended", false)
  return (
    <FieldGroup>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("cwd.label")} htmlFor="tsopen-cwd" hint={t("cwd.hint")} name="cwd">
          <Input
            id="tsopen-cwd"
            value={cwd}
            onChange={(e) => onChange(patchParam(params, "cwd", e.target.value))}
            placeholder={t("cwd.placeholder")}
          />
        </Field>
        <Field label={t("shell.label")} htmlFor="tsopen-shell" hint={t("shell.hint")} name="shell">
          <Input
            id="tsopen-shell"
            value={shell}
            onChange={(e) => onChange(patchParam(params, "shell", e.target.value))}
            placeholder={t("shell.placeholder")}
          />
        </Field>
      </div>
      <div className="flex items-center justify-between gap-3">
        <Field
          label={t("unattended.label")}
          htmlFor="tsopen-unattended"
          hint={t("unattended.hint")}
          name="unattended"
        >
          <Switch
            id="tsopen-unattended"
            checked={unattended}
            onCheckedChange={(v) => onChange(patchParam(params, "unattended", v))}
          />
        </Field>
      </div>
    </FieldGroup>
  )
}

export function TerminalSessionRunConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.terminalSessionRun")
  const sessionId = readString(params, "sessionId")
  const command = readString(params, "command")
  const timeoutSec = readNumber(params, "timeoutSec", 60)
  const onFailure = readString(params, "onFailure", "throw")
  const onAskVerdict = readString(params, "onAskVerdict", "fail")
  return (
    <FieldGroup>
      <Field
        label={t("sessionId.label")}
        htmlFor="tsrun-session"
        hint={t("sessionId.hint")}
        name="sessionId"
        required
      >
        <Input
          id="tsrun-session"
          value={sessionId}
          onChange={(e) => onChange(patchParam(params, "sessionId", e.target.value))}
          placeholder={t("sessionId.placeholder")}
          className="font-mono text-xs"
        />
      </Field>
      <Field
        label={t("command.label")}
        htmlFor="tsrun-command"
        hint={t("command.hint")}
        name="command"
        required
      >
        <Textarea
          id="tsrun-command"
          value={command}
          onChange={(e) => onChange(patchParam(params, "command", e.target.value))}
          placeholder={t("command.placeholder")}
          rows={3}
          className="font-mono text-xs"
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field
          label={t("timeoutSec.label")}
          htmlFor="tsrun-timeout"
          hint={t("timeoutSec.hint")}
          name="timeoutSec"
        >
          <Input
            id="tsrun-timeout"
            type="number"
            min={5}
            max={600}
            value={timeoutSec}
            onChange={(e) =>
              onChange(
                patchParam(
                  params,
                  "timeoutSec",
                  Math.max(5, Math.min(600, Number(e.target.value) || 60))
                )
              )
            }
          />
        </Field>
        <Field
          label={t("onFailure.label")}
          htmlFor="tsrun-onfail"
          hint={t("onFailure.hint")}
          name="onFailure"
        >
          <Select
            value={onFailure}
            onValueChange={(v) => onChange(patchParam(params, "onFailure", v))}
          >
            <SelectTrigger id="tsrun-onfail">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="throw">{t("onFailure.options.throw")}</SelectItem>
              <SelectItem value="branch">{t("onFailure.options.branch")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field
        label={t("onAskVerdict.label")}
        htmlFor="tsrun-askverdict"
        hint={t("onAskVerdict.hint")}
        name="onAskVerdict"
      >
        <Select
          value={onAskVerdict}
          onValueChange={(v) => onChange(patchParam(params, "onAskVerdict", v))}
        >
          <SelectTrigger id="tsrun-askverdict">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="fail">{t("onAskVerdict.options.fail")}</SelectItem>
            <SelectItem value="consent">{t("onAskVerdict.options.consent")}</SelectItem>
            <SelectItem value="run">{t("onAskVerdict.options.run")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </FieldGroup>
  )
}

export function TerminalSessionCloseConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.terminalSessionClose")
  const sessionId = readString(params, "sessionId")
  return (
    <FieldGroup>
      <Field
        label={t("sessionId.label")}
        htmlFor="tsclose-session"
        hint={t("sessionId.hint")}
        name="sessionId"
        required
      >
        <Input
          id="tsclose-session"
          value={sessionId}
          onChange={(e) => onChange(patchParam(params, "sessionId", e.target.value))}
          placeholder={t("sessionId.placeholder")}
          className="font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.terminal.script ──────────────────────────────────────────────────
export function TerminalScriptConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.terminalScript")
  const scriptPath = readString(params, "scriptPath")
  const interpreter = readString(params, "interpreter")
  const cwd = readString(params, "cwd")
  const timeoutSec = readNumber(params, "timeoutSec", 60)
  const onFailure = readString(params, "onFailure", "throw")
  const unattended = readBoolean(params, "unattended", false)
  const onAskVerdict = readString(params, "onAskVerdict", "fail")
  return (
    <FieldGroup>
      <Field
        label={t("scriptPath.label")}
        htmlFor="tscript-path"
        hint={t("scriptPath.hint")}
        name="scriptPath"
        required
      >
        <Input
          id="tscript-path"
          value={scriptPath}
          onChange={(e) => onChange(patchParam(params, "scriptPath", e.target.value))}
          placeholder={t("scriptPath.placeholder")}
          className="font-mono text-xs"
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field
          label={t("interpreter.label")}
          htmlFor="tscript-interp"
          hint={t("interpreter.hint")}
          name="interpreter"
        >
          <Input
            id="tscript-interp"
            value={interpreter}
            onChange={(e) => onChange(patchParam(params, "interpreter", e.target.value))}
            placeholder={t("interpreter.placeholder")}
          />
        </Field>
        <Field label={t("cwd.label")} htmlFor="tscript-cwd" hint={t("cwd.hint")} name="cwd">
          <Input
            id="tscript-cwd"
            value={cwd}
            onChange={(e) => onChange(patchParam(params, "cwd", e.target.value))}
            placeholder={t("cwd.placeholder")}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field
          label={t("timeoutSec.label")}
          htmlFor="tscript-timeout"
          hint={t("timeoutSec.hint")}
          name="timeoutSec"
        >
          <Input
            id="tscript-timeout"
            type="number"
            min={5}
            max={600}
            value={timeoutSec}
            onChange={(e) =>
              onChange(
                patchParam(
                  params,
                  "timeoutSec",
                  Math.max(5, Math.min(600, Number(e.target.value) || 60))
                )
              )
            }
          />
        </Field>
        <Field
          label={t("onFailure.label")}
          htmlFor="tscript-onfail"
          hint={t("onFailure.hint")}
          name="onFailure"
        >
          <Select
            value={onFailure}
            onValueChange={(v) => onChange(patchParam(params, "onFailure", v))}
          >
            <SelectTrigger id="tscript-onfail">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="throw">{t("onFailure.options.throw")}</SelectItem>
              <SelectItem value="branch">{t("onFailure.options.branch")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <TerminalUnattendedFields
        params={params}
        onChange={onChange}
        unattended={unattended}
        onAskVerdict={onAskVerdict}
        idPrefix="tscript"
      />
    </FieldGroup>
  )
}

// ── action.terminal.readRecent ──────────────────────────────────────────────
export function TerminalReadRecentConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.terminalReadRecent")
  const tabId = readString(params, "tabId")
  const lineLimit = readNumber(params, "lineLimit", 10)
  return (
    <FieldGroup>
      <Field
        label={t("tabId.label")}
        htmlFor="tread-tab"
        hint={t("tabId.hint")}
        name="tabId"
        required
      >
        <Input
          id="tread-tab"
          value={tabId}
          onChange={(e) => onChange(patchParam(params, "tabId", e.target.value))}
          placeholder={t("tabId.placeholder")}
          className="font-mono text-xs"
        />
      </Field>
      <Field
        label={t("lineLimit.label")}
        htmlFor="tread-limit"
        hint={t("lineLimit.hint")}
        name="lineLimit"
      >
        <Input
          id="tread-limit"
          type="number"
          min={1}
          max={50}
          value={lineLimit}
          onChange={(e) =>
            onChange(
              patchParam(
                params,
                "lineLimit",
                Math.max(1, Math.min(50, Number(e.target.value) || 10))
              )
            )
          }
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.terminal.waitForExit ─────────────────────────────────────────────
export function TerminalWaitForExitConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.terminalWaitForExit")
  const tabId = readString(params, "tabId")
  const timeoutSec = readNumber(params, "timeoutSec", 60)
  const onFailure = readString(params, "onFailure", "throw")
  return (
    <FieldGroup>
      <Field
        label={t("tabId.label")}
        htmlFor="twait-tab"
        hint={t("tabId.hint")}
        name="tabId"
        required
      >
        <Input
          id="twait-tab"
          value={tabId}
          onChange={(e) => onChange(patchParam(params, "tabId", e.target.value))}
          placeholder={t("tabId.placeholder")}
          className="font-mono text-xs"
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field
          label={t("timeoutSec.label")}
          htmlFor="twait-timeout"
          hint={t("timeoutSec.hint")}
          name="timeoutSec"
        >
          <Input
            id="twait-timeout"
            type="number"
            min={5}
            max={600}
            value={timeoutSec}
            onChange={(e) =>
              onChange(
                patchParam(
                  params,
                  "timeoutSec",
                  Math.max(5, Math.min(600, Number(e.target.value) || 60))
                )
              )
            }
          />
        </Field>
        <Field
          label={t("onFailure.label")}
          htmlFor="twait-onfail"
          hint={t("onFailure.hint")}
          name="onFailure"
        >
          <Select
            value={onFailure}
            onValueChange={(v) => onChange(patchParam(params, "onFailure", v))}
          >
            <SelectTrigger id="twait-onfail">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="throw">{t("onFailure.options.throw")}</SelectItem>
              <SelectItem value="branch">{t("onFailure.options.branch")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
    </FieldGroup>
  )
}

// ── trigger.terminal.command ────────────────────────────────────────────────
export function TerminalCommandTriggerConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.terminalCommandTrigger")
  const sessionId = readString(params, "sessionId")
  const projectId = readString(params, "projectId")
  const status = readString(params, "status", "any")
  const commandContains = readString(params, "commandContains")
  return (
    <FieldGroup>
      <div className="grid grid-cols-2 gap-2">
        <Field
          label={t("sessionId.label")}
          htmlFor="ttrig-session"
          hint={t("sessionId.hint")}
          name="sessionId"
        >
          <Input
            id="ttrig-session"
            value={sessionId}
            onChange={(e) => onChange(patchParam(params, "sessionId", e.target.value))}
            placeholder={t("sessionId.placeholder")}
            className="font-mono text-xs"
          />
        </Field>
        <Field
          label={t("projectId.label")}
          htmlFor="ttrig-project"
          hint={t("projectId.hint")}
          name="projectId"
        >
          <Input
            id="ttrig-project"
            value={projectId}
            onChange={(e) => onChange(patchParam(params, "projectId", e.target.value))}
            placeholder={t("projectId.placeholder")}
          />
        </Field>
      </div>
      <Field label={t("status.label")} htmlFor="ttrig-status" hint={t("status.hint")} name="status">
        <Select
          value={status === "" ? "any" : status}
          onValueChange={(v) => onChange(patchParam(params, "status", v === "any" ? "" : v))}
        >
          <SelectTrigger id="ttrig-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">{t("status.options.any")}</SelectItem>
            <SelectItem value="success">{t("status.options.success")}</SelectItem>
            <SelectItem value="failure">{t("status.options.failure")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("commandContains.label")}
        htmlFor="ttrig-contains"
        hint={t("commandContains.hint")}
        name="commandContains"
      >
        <Input
          id="ttrig-contains"
          value={commandContains}
          onChange={(e) => onChange(patchParam(params, "commandContains", e.target.value))}
          placeholder={t("commandContains.placeholder")}
          className="font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  )
}

// Suppress unused-import warnings when only one of these helpers is exercised
// in a given form's tests. They're real call sites in production.
void listAdapterInstances
