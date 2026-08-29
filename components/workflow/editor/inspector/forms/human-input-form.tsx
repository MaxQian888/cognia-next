"use client"

import { useTranslations } from "next-intl"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
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
import type {
  HumanInputAction,
  HumanInputAssignee,
  HumanInputCompletionPolicy,
  HumanInputField,
  HumanInputFieldType,
} from "@/types/workflow/human-input"
import { Field, FieldGroup, patchParam, readNumber, readString, FieldRow } from "./shared"
import type { ConfigProps } from "./form-support"

const FIELD_TYPES: HumanInputFieldType[] = [
  "short-text",
  "long-text",
  "number",
  "boolean",
  "single-select",
  "multi-select",
  "file",
  "file-list",
]

function uniqueId(prefix: string, existing: readonly { id: string }[]): string {
  const used = new Set(existing.map((item) => item.id))
  for (let index = 1; ; index++) {
    const candidate = `${prefix}_${index}`
    if (!used.has(candidate)) return candidate
  }
}

export function HumanInputRequestConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.humanInputRequest")
  const title = readString(params, "title")
  const message = readString(params, "message")
  const timeoutMs = readNumber(params, "timeoutMs", 3 * 24 * 60 * 60 * 1000)
  const sensitiveRetentionDays = readNumber(params, "sensitiveRetentionDays", 30)
  const fields = Array.isArray(params.fields) ? (params.fields as HumanInputField[]) : []
  const actions = Array.isArray(params.actions) ? (params.actions as HumanInputAction[]) : []
  const assignees = Array.isArray(params.assignees)
    ? (params.assignees as HumanInputAssignee[])
    : []
  const completionPolicy =
    params.completionPolicy && typeof params.completionPolicy === "object"
      ? (params.completionPolicy as HumanInputCompletionPolicy)
      : ({ mode: "any" } as const)

  const setFields = (next: HumanInputField[]) => onChange(patchParam(params, "fields", next))
  const setActions = (next: HumanInputAction[]) => onChange(patchParam(params, "actions", next))
  const setAssignees = (next: HumanInputAssignee[]) =>
    onChange(patchParam(params, "assignees", next))

  return (
    <FieldGroup>
      <Field label={t("title")} htmlFor="hir-title" name="title" required>
        <Input
          id="hir-title"
          value={title}
          onChange={(event) => onChange(patchParam(params, "title", event.target.value))}
        />
      </Field>
      <Field label={t("message")} htmlFor="hir-message" name="message">
        <Textarea
          id="hir-message"
          value={message}
          rows={3}
          onChange={(event) => onChange(patchParam(params, "message", event.target.value))}
        />
      </Field>

      <section className="space-y-2" aria-label={t("fields.label")}>
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium">{t("fields.label")}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              setFields([
                ...fields,
                {
                  id: uniqueId("field", fields),
                  type: "short-text",
                  label: t("fields.defaultLabel"),
                },
              ])
            }
          >
            <Plus /> {t("fields.add")}
          </Button>
        </div>
        {fields.map((field, index) => (
          <div key={`${field.id}:${index}`} className="space-y-2 rounded-md border p-2">
            <FieldRow className="gap-2">
              <Input
                aria-label={t("fields.id")}
                value={field.id}
                onChange={(event) => {
                  const next = [...fields]
                  next[index] = { ...field, id: event.target.value }
                  setFields(next)
                }}
              />
              <Input
                aria-label={t("fields.fieldLabel")}
                value={field.label}
                onChange={(event) => {
                  const next = [...fields]
                  next[index] = { ...field, label: event.target.value }
                  setFields(next)
                }}
              />
            </FieldRow>
            <div className="flex items-center gap-2">
              <Select
                value={field.type}
                onValueChange={(value) => {
                  const next = [...fields]
                  next[index] = { ...field, type: value as HumanInputFieldType }
                  setFields(next)
                }}
              >
                <SelectTrigger aria-label={t("fields.type")} className="flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FIELD_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(`fields.types.${type}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <label className="flex items-center gap-1 text-xs">
                <Switch
                  aria-label={t("fields.required")}
                  checked={Boolean(field.required)}
                  onCheckedChange={(checked) => {
                    const next = [...fields]
                    next[index] = { ...field, required: checked || undefined }
                    setFields(next)
                  }}
                />
                {t("fields.required")}
              </label>
              <label className="flex items-center gap-1 text-xs">
                <Switch
                  aria-label={t("fields.sensitive")}
                  checked={Boolean(field.sensitive)}
                  onCheckedChange={(checked) => {
                    const next = [...fields]
                    next[index] = { ...field, sensitive: checked || undefined }
                    setFields(next)
                  }}
                />
                {t("fields.sensitive")}
              </label>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t("fields.remove")}
                onClick={() => setFields(fields.filter((_, itemIndex) => itemIndex !== index))}
              >
                <Trash2 />
              </Button>
            </div>
            {(field.type === "single-select" || field.type === "multi-select") && (
              <Input
                aria-label={t("fields.options")}
                placeholder={t("fields.optionsPlaceholder")}
                value={(field.options ?? []).map((option) => option.value).join(", ")}
                onChange={(event) => {
                  const next = [...fields]
                  const options = event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean)
                    .map((value) => ({ value, label: value }))
                  next[index] = { ...field, options }
                  setFields(next)
                }}
              />
            )}
          </div>
        ))}
      </section>

      <section className="space-y-2" aria-label={t("actions.label")}>
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium">{t("actions.label")}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              setActions([
                ...actions,
                {
                  id: uniqueId("action", actions),
                  label: t("actions.defaultLabel"),
                  tone: actions.length === 0 ? "primary" : "secondary",
                },
              ])
            }
          >
            <Plus /> {t("actions.add")}
          </Button>
        </div>
        {actions.map((action, index) => (
          <div key={`${action.id}:${index}`} className="flex items-center gap-2">
            <Input
              aria-label={t("actions.id")}
              value={action.id}
              onChange={(event) => {
                const next = [...actions]
                next[index] = { ...action, id: event.target.value }
                setActions(next)
              }}
            />
            <Input
              aria-label={t("actions.actionLabel")}
              value={action.label}
              onChange={(event) => {
                const next = [...actions]
                next[index] = { ...action, label: event.target.value }
                setActions(next)
              }}
            />
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t("actions.remove")}
              onClick={() => setActions(actions.filter((_, itemIndex) => itemIndex !== index))}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </section>

      <section className="space-y-2" aria-label={t("assignees.label")}>
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium">{t("assignees.label")}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setAssignees([...assignees, { kind: "member", id: "" }])}
          >
            <Plus /> {t("assignees.add")}
          </Button>
        </div>
        {assignees.map((assignee, index) => (
          <div key={`${assignee.kind}:${index}`} className="flex items-center gap-2">
            <Select
              value={assignee.kind}
              onValueChange={(kind) => {
                const next = [...assignees]
                next[index] =
                  kind === "initiator"
                    ? { kind: "initiator" }
                    : { kind: kind as "member" | "group", id: "" }
                setAssignees(next)
              }}
            >
              <SelectTrigger aria-label={t("assignees.kind")} className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="initiator">{t("assignees.initiator")}</SelectItem>
                <SelectItem value="member">{t("assignees.member")}</SelectItem>
                <SelectItem value="group">{t("assignees.group")}</SelectItem>
              </SelectContent>
            </Select>
            {assignee.kind !== "initiator" && (
              <Input
                aria-label={t("assignees.id")}
                value={assignee.id}
                onChange={(event) => {
                  const next = [...assignees]
                  next[index] = { ...assignee, id: event.target.value }
                  setAssignees(next)
                }}
              />
            )}
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t("assignees.remove")}
              onClick={() => setAssignees(assignees.filter((_, itemIndex) => itemIndex !== index))}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </section>

      <FieldRow className="gap-2">
        <Field label={t("completion.label")} htmlFor="hir-completion" name="completionPolicy">
          <Select
            value={completionPolicy.mode}
            onValueChange={(mode) =>
              onChange(
                patchParam(
                  params,
                  "completionPolicy",
                  mode === "quorum" ? { mode, count: 1 } : { mode }
                )
              )
            }
          >
            <SelectTrigger id="hir-completion">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">{t("completion.any")}</SelectItem>
              <SelectItem value="all">{t("completion.all")}</SelectItem>
              <SelectItem value="quorum">{t("completion.quorum")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {completionPolicy.mode === "quorum" && (
          <Field label={t("completion.count")} htmlFor="hir-quorum" name="quorumCount">
            <Input
              id="hir-quorum"
              type="number"
              min={1}
              value={completionPolicy.count}
              onChange={(event) =>
                onChange(
                  patchParam(params, "completionPolicy", {
                    mode: "quorum",
                    count: Math.max(1, Number(event.target.value) || 1),
                  })
                )
              }
            />
          </Field>
        )}
      </FieldRow>
      <Field label={t("timeout")} htmlFor="hir-timeout" name="timeoutMs">
        <Input
          id="hir-timeout"
          type="number"
          min={60_000}
          max={30 * 24 * 60 * 60 * 1000}
          value={timeoutMs}
          onChange={(event) =>
            onChange(patchParam(params, "timeoutMs", Number(event.target.value) || undefined))
          }
        />
      </Field>
      <Field
        label={t("sensitiveRetentionDays")}
        htmlFor="hir-sensitive-retention"
        name="sensitiveRetentionDays"
      >
        <Input
          id="hir-sensitive-retention"
          type="number"
          min={1}
          max={30}
          value={sensitiveRetentionDays}
          onChange={(event) =>
            onChange(
              patchParam(params, "sensitiveRetentionDays", Number(event.target.value) || undefined)
            )
          }
        />
      </Field>
    </FieldGroup>
  )
}
