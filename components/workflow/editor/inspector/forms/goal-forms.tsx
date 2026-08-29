"use client"

import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Field,
  FieldGroup,
  readBoolean,
  readNumber,
  readString,
  patchParam,
  FieldRow,
} from "./shared"
import { CharacterPicker } from "./shared/entity-picker"
import { GoalTemplateIdField, clampNumberInput, parseObjectJson } from "./form-support"
import type { ConfigProps } from "./form-support"

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
      <FieldRow>
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
      </FieldRow>
    </FieldGroup>
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
      <FieldRow>
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
      </FieldRow>
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
