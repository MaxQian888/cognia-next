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
import { Field, FieldGroup, readNumber, readString, patchParam } from "./shared"
import {
  SCHEDULER_STATUSES,
  SCHEDULER_TASK_TYPES,
  SCHEDULER_TRIGGER_TYPES,
  SchedulerLimitConfig,
  SchedulerTaskIdField,
  SchedulerTaskJsonFields,
  clampNumberInput,
  patchJsonObjectField,
} from "./form-support"
import type { ConfigProps } from "./form-support"

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
