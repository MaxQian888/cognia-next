"use client"

import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Field, FieldGroup, readNumber, readString, patchParam, FieldRow } from "./shared"
import { CharacterPicker } from "./shared/entity-picker"
import {
  PLAN_EXECUTION_MODES,
  PLAN_REFINEMENT_TRIGGERS,
  PLAN_REFINEMENT_TYPES,
  PLAN_SOURCES,
  PLAN_STATUSES,
  PLAN_STEP_STATUSES,
  PlanIdField,
  clampNumberInput,
  parseArrayJson,
  parseObjectJson,
} from "./form-support"
import type { ConfigProps } from "./form-support"

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
      <FieldRow>
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
      </FieldRow>
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
      <FieldRow>
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
      </FieldRow>
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
