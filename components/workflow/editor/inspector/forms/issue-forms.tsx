"use client"

/**
 * Inspector forms for the `action.issue.*` nodes and `trigger.issue.event`
 * (spec 2026-09-06 D9). Field names mirror `IssueCreateParams` and friends in
 * `lib/workflow/nodes/params-schemas.ts`, so what the form writes is exactly
 * what the executor reads.
 */

import { useTranslations } from "next-intl"

import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "@/types/issues"
import type { ConfigProps } from "./form-support"
import { Field, FieldGroup, FieldRow, patchParam, readNumber, readString } from "./shared"

const ISSUE_TRIGGER_KINDS = [
  "created",
  "status_changed",
  "assigned",
  "commented",
  "run_started",
  "run_succeeded",
  "run_failed",
] as const

/** `"a, b"` in the box, `["a", "b"]` in the params. */
function readNames(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string").join(", ")
  return typeof value === "string" ? value : ""
}

function patchNames(params: Record<string, unknown>, key: string, raw: string) {
  const names = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
  return patchParam(params, key, names.length ? names : undefined)
}

/** Optional number: an empty box means "not given", never zero. */
function patchOptionalNumber(params: Record<string, unknown>, key: string, raw: string) {
  const trimmed = raw.trim()
  if (!trimmed) return patchParam(params, key, undefined)
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) && parsed >= 0 ? patchParam(params, key, parsed) : params
}

function IssueRefField({ params, onChange, id }: ConfigProps & { id: string }) {
  const t = useTranslations("workflows.forms.issueCommon")
  return (
    <Field label={t("issue.label")} htmlFor={id} hint={t("issue.hint")} name="issue">
      <Input
        id={id}
        value={readString(params, "issue")}
        placeholder={t("issue.placeholder")}
        onChange={(e) => onChange(patchParam(params, "issue", e.target.value))}
      />
    </Field>
  )
}

function ContainerFields({ params, onChange, prefix }: ConfigProps & { prefix: string }) {
  const t = useTranslations("workflows.forms.issueCommon")
  return (
    <FieldRow>
      <Field
        label={t("projectKey.label")}
        htmlFor={`${prefix}-key`}
        hint={t("projectKey.hint")}
        name="projectKey"
      >
        <Input
          id={`${prefix}-key`}
          value={readString(params, "projectKey")}
          placeholder={t("projectKey.placeholder")}
          onChange={(e) => onChange(patchParam(params, "projectKey", e.target.value || undefined))}
        />
      </Field>
      <Field
        label={t("issueProjectId.label")}
        htmlFor={`${prefix}-container`}
        hint={t("issueProjectId.hint")}
        name="issueProjectId"
      >
        <Input
          id={`${prefix}-container`}
          value={readString(params, "issueProjectId")}
          onChange={(e) =>
            onChange(patchParam(params, "issueProjectId", e.target.value || undefined))
          }
        />
      </Field>
    </FieldRow>
  )
}

function EnumSelect({
  id,
  value,
  options,
  noneLabel,
  labelFor,
  onChange,
}: {
  id: string
  value: string
  options: readonly string[]
  noneLabel: string
  labelFor: (option: string) => string
  onChange: (next: string | undefined) => void
}) {
  return (
    <Select
      value={value || "__none"}
      onValueChange={(v) => onChange(v === "__none" ? undefined : v)}
    >
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none">{noneLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {labelFor(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function IssueCreateConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.issueCreate")
  const tc = useTranslations("workflows.forms.issueCommon")
  const ti = useTranslations("issues")
  return (
    <FieldGroup>
      <Field label={t("title.label")} htmlFor="issue-create-title" name="title">
        <Input
          id="issue-create-title"
          value={readString(params, "title")}
          onChange={(e) => onChange(patchParam(params, "title", e.target.value))}
        />
      </Field>
      <Field label={t("description.label")} htmlFor="issue-create-description" name="description">
        <Textarea
          id="issue-create-description"
          rows={3}
          value={readString(params, "description")}
          onChange={(e) => onChange(patchParam(params, "description", e.target.value || undefined))}
        />
      </Field>
      <ContainerFields params={params} onChange={onChange} prefix="issue-create" />
      <FieldRow>
        <Field label={tc("status.label")} htmlFor="issue-create-status" name="status">
          <EnumSelect
            id="issue-create-status"
            value={readString(params, "status")}
            options={ISSUE_STATUSES}
            noneLabel={tc("status.default")}
            labelFor={(s) => ti(`status.${s}`)}
            onChange={(v) => onChange(patchParam(params, "status", v))}
          />
        </Field>
        <Field label={tc("priority.label")} htmlFor="issue-create-priority" name="priority">
          <EnumSelect
            id="issue-create-priority"
            value={readString(params, "priority")}
            options={ISSUE_PRIORITIES}
            noneLabel={tc("priority.default")}
            labelFor={(p) => ti(`priority.${p}`)}
            onChange={(v) => onChange(patchParam(params, "priority", v))}
          />
        </Field>
      </FieldRow>
      <Field
        label={tc("labels.label")}
        htmlFor="issue-create-labels"
        hint={tc("labels.hint")}
        name="labels"
      >
        <Input
          id="issue-create-labels"
          value={readNames(params, "labels")}
          onChange={(e) => onChange(patchNames(params, "labels", e.target.value))}
        />
      </Field>
      <FieldRow>
        <Field label={tc("estimate.label")} htmlFor="issue-create-estimate" name="estimate">
          <Input
            id="issue-create-estimate"
            type="number"
            min={0}
            value={params.estimate === undefined ? "" : readNumber(params, "estimate")}
            onChange={(e) => onChange(patchOptionalNumber(params, "estimate", e.target.value))}
          />
        </Field>
        <Field
          label={tc("dueDate.label")}
          htmlFor="issue-create-due"
          hint={tc("dueDate.hint")}
          name="dueDate"
        >
          <Input
            id="issue-create-due"
            type="number"
            min={0}
            value={params.dueDate === undefined ? "" : readNumber(params, "dueDate")}
            onChange={(e) => onChange(patchOptionalNumber(params, "dueDate", e.target.value))}
          />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label={tc("parentId.label")} htmlFor="issue-create-parent" name="parentId">
          <Input
            id="issue-create-parent"
            value={readString(params, "parentId")}
            onChange={(e) => onChange(patchParam(params, "parentId", e.target.value || undefined))}
          />
        </Field>
        <Field label={tc("cycleId.label")} htmlFor="issue-create-cycle" name="cycleId">
          <Input
            id="issue-create-cycle"
            value={readString(params, "cycleId")}
            onChange={(e) => onChange(patchParam(params, "cycleId", e.target.value || undefined))}
          />
        </Field>
      </FieldRow>
    </FieldGroup>
  )
}

export function IssueRefConfig({ params, onChange }: ConfigProps) {
  return (
    <FieldGroup>
      <IssueRefField params={params} onChange={onChange} id="issue-ref" />
    </FieldGroup>
  )
}

export function IssueListConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.issueList")
  const tc = useTranslations("workflows.forms.issueCommon")
  const ti = useTranslations("issues")
  const selected = Array.isArray(params.statuses) ? (params.statuses as string[]) : []
  const toggle = (status: string) => {
    const next = selected.includes(status)
      ? selected.filter((s) => s !== status)
      : [...selected, status]
    onChange(patchParam(params, "statuses", next.length ? next : undefined))
  }
  return (
    <FieldGroup>
      <ContainerFields params={params} onChange={onChange} prefix="issue-list" />
      <Field label={t("statuses.label")} hint={t("statuses.hint")} name="statuses">
        <div className="space-y-1.5">
          {ISSUE_STATUSES.map((status) => (
            <label
              key={status}
              className="flex items-center gap-2 rounded-md border bg-muted/20 px-2 py-1.5 text-sm hover:bg-muted/40"
            >
              <Checkbox
                checked={selected.includes(status)}
                onCheckedChange={() => toggle(status)}
                data-testid={`issue-list-status-${status}`}
              />
              <span>{ti(`status.${status}`)}</span>
            </label>
          ))}
        </div>
      </Field>
      <Field label={t("text.label")} htmlFor="issue-list-text" hint={t("text.hint")} name="text">
        <Input
          id="issue-list-text"
          value={readString(params, "text")}
          onChange={(e) => onChange(patchParam(params, "text", e.target.value || undefined))}
        />
      </Field>
      <FieldRow>
        <Field label={tc("cycleId.label")} htmlFor="issue-list-cycle" name="cycleId">
          <Input
            id="issue-list-cycle"
            value={readString(params, "cycleId")}
            onChange={(e) => onChange(patchParam(params, "cycleId", e.target.value || undefined))}
          />
        </Field>
        <Field label={t("limit.label")} htmlFor="issue-list-limit" name="limit">
          <Input
            id="issue-list-limit"
            type="number"
            min={1}
            max={500}
            value={params.limit === undefined ? "" : readNumber(params, "limit")}
            onChange={(e) => onChange(patchOptionalNumber(params, "limit", e.target.value))}
          />
        </Field>
      </FieldRow>
    </FieldGroup>
  )
}

export function IssueUpdateConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.issueUpdate")
  const tc = useTranslations("workflows.forms.issueCommon")
  const ti = useTranslations("issues")
  return (
    <FieldGroup>
      <IssueRefField params={params} onChange={onChange} id="issue-update-ref" />
      <p className="text-xs text-muted-foreground">{t("intro")}</p>
      <Field label={t("title.label")} htmlFor="issue-update-title" name="title">
        <Input
          id="issue-update-title"
          value={readString(params, "title")}
          onChange={(e) => onChange(patchParam(params, "title", e.target.value || undefined))}
        />
      </Field>
      <Field label={t("description.label")} htmlFor="issue-update-description" name="description">
        <Textarea
          id="issue-update-description"
          rows={3}
          value={readString(params, "description")}
          onChange={(e) => onChange(patchParam(params, "description", e.target.value || undefined))}
        />
      </Field>
      <FieldRow>
        <Field label={tc("status.label")} htmlFor="issue-update-status" name="status">
          <EnumSelect
            id="issue-update-status"
            value={readString(params, "status")}
            options={ISSUE_STATUSES}
            noneLabel={t("unchanged")}
            labelFor={(s) => ti(`status.${s}`)}
            onChange={(v) => onChange(patchParam(params, "status", v))}
          />
        </Field>
        <Field label={tc("priority.label")} htmlFor="issue-update-priority" name="priority">
          <EnumSelect
            id="issue-update-priority"
            value={readString(params, "priority")}
            options={ISSUE_PRIORITIES}
            noneLabel={t("unchanged")}
            labelFor={(p) => ti(`priority.${p}`)}
            onChange={(v) => onChange(patchParam(params, "priority", v))}
          />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label={tc("estimate.label")} htmlFor="issue-update-estimate" name="estimate">
          <Input
            id="issue-update-estimate"
            type="number"
            min={0}
            value={typeof params.estimate === "number" ? params.estimate : ""}
            onChange={(e) => onChange(patchOptionalNumber(params, "estimate", e.target.value))}
          />
        </Field>
        <Field
          label={tc("dueDate.label")}
          htmlFor="issue-update-due"
          hint={tc("dueDate.hint")}
          name="dueDate"
        >
          <Input
            id="issue-update-due"
            type="number"
            min={0}
            value={typeof params.dueDate === "number" ? params.dueDate : ""}
            onChange={(e) => onChange(patchOptionalNumber(params, "dueDate", e.target.value))}
          />
        </Field>
      </FieldRow>
      <Field
        label={tc("cycleId.label")}
        htmlFor="issue-update-cycle"
        hint={t("cycleId.hint")}
        name="cycleId"
      >
        <Input
          id="issue-update-cycle"
          value={readString(params, "cycleId")}
          onChange={(e) => onChange(patchParam(params, "cycleId", e.target.value || undefined))}
        />
      </Field>
    </FieldGroup>
  )
}

export function IssueAssignConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.issueAssign")
  const kind = readString(params, "assigneeKind", "none")
  return (
    <FieldGroup>
      <IssueRefField params={params} onChange={onChange} id="issue-assign-ref" />
      <Field label={t("assigneeKind.label")} htmlFor="issue-assign-kind" name="assigneeKind">
        <Select value={kind} onValueChange={(v) => onChange(patchParam(params, "assigneeKind", v))}>
          <SelectTrigger id="issue-assign-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["none", "human", "agent", "team"].map((option) => (
              <SelectItem key={option} value={option}>
                {t(`assigneeKind.options.${option}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {kind === "agent" || kind === "team" ? (
        <FieldRow>
          <Field
            label={t("assigneeId.label")}
            htmlFor="issue-assign-id"
            hint={t("assigneeId.hint")}
            name="assigneeId"
          >
            <Input
              id="issue-assign-id"
              value={readString(params, "assigneeId")}
              onChange={(e) => onChange(patchParam(params, "assigneeId", e.target.value))}
            />
          </Field>
          <Field label={t("assigneeLabel.label")} htmlFor="issue-assign-label" name="assigneeLabel">
            <Input
              id="issue-assign-label"
              value={readString(params, "assigneeLabel")}
              onChange={(e) =>
                onChange(patchParam(params, "assigneeLabel", e.target.value || undefined))
              }
            />
          </Field>
        </FieldRow>
      ) : null}
    </FieldGroup>
  )
}

export function IssueCommentConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.issueComment")
  return (
    <FieldGroup>
      <IssueRefField params={params} onChange={onChange} id="issue-comment-ref" />
      <Field label={t("body.label")} htmlFor="issue-comment-body" hint={t("body.hint")} name="body">
        <Textarea
          id="issue-comment-body"
          rows={4}
          value={readString(params, "body")}
          onChange={(e) => onChange(patchParam(params, "body", e.target.value))}
        />
      </Field>
    </FieldGroup>
  )
}

export function IssueLabelConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.issueLabel")
  return (
    <FieldGroup>
      <IssueRefField params={params} onChange={onChange} id="issue-label-ref" />
      <Field label={t("add.label")} htmlFor="issue-label-add" hint={t("add.hint")} name="add">
        <Input
          id="issue-label-add"
          value={readNames(params, "add")}
          onChange={(e) => onChange(patchNames(params, "add", e.target.value))}
        />
      </Field>
      <Field
        label={t("remove.label")}
        htmlFor="issue-label-remove"
        hint={t("remove.hint")}
        name="remove"
      >
        <Input
          id="issue-label-remove"
          value={readNames(params, "remove")}
          onChange={(e) => onChange(patchNames(params, "remove", e.target.value))}
        />
      </Field>
    </FieldGroup>
  )
}

export function IssueEventTriggerConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.issueEventTrigger")
  const tc = useTranslations("workflows.forms.issueCommon")
  const selected = Array.isArray(params.kinds) ? (params.kinds as string[]) : []
  const cooldownMs = readNumber(params, "cooldownMs", 2000)
  const toggle = (kind: string) => {
    const next = selected.includes(kind) ? selected.filter((k) => k !== kind) : [...selected, kind]
    onChange(patchParam(params, "kinds", next.length ? next : undefined))
  }
  return (
    <FieldGroup>
      <p className="text-xs text-muted-foreground">{t("intro")}</p>
      <Field label={t("kinds.label")} hint={t("kinds.hint")} name="kinds">
        <div className="space-y-1.5">
          {ISSUE_TRIGGER_KINDS.map((kind) => (
            <label
              key={kind}
              className="flex items-center gap-2 rounded-md border bg-muted/20 px-2 py-1.5 text-sm hover:bg-muted/40"
            >
              <Checkbox
                checked={selected.includes(kind)}
                onCheckedChange={() => toggle(kind)}
                data-testid={`issue-event-${kind}`}
              />
              <span>{t(`kinds.options.${kind}`)}</span>
            </label>
          ))}
        </div>
      </Field>
      <Field
        label={tc("issueProjectId.label")}
        htmlFor="issue-event-container"
        hint={t("issueProjectId.hint")}
        name="issueProjectId"
      >
        <Input
          id="issue-event-container"
          value={readString(params, "issueProjectId")}
          onChange={(e) =>
            onChange(patchParam(params, "issueProjectId", e.target.value || undefined))
          }
        />
      </Field>
      <Field
        label={t("cooldownMs.label")}
        htmlFor="issue-event-cooldown"
        hint={t("cooldownMs.hint")}
        name="cooldownMs"
      >
        <Input
          id="issue-event-cooldown"
          type="number"
          min={0}
          max={300000}
          value={cooldownMs}
          onChange={(e) => onChange(patchOptionalNumber(params, "cooldownMs", e.target.value))}
        />
      </Field>
    </FieldGroup>
  )
}
