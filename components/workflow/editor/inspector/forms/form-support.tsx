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
import { Button } from "@/components/ui/button"
import { Plus, Trash2 } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectGroup,
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
import { ExpressionField } from "./shared/expression-field"
import { ModelPicker } from "./shared/entity-picker"
import { ConditionBuilder } from "./shared/condition-builder"
import type { WorkflowConditionGroup } from "@/types/workflow/conditions"
import { useInspectorExpressionCtx } from "./shared/inspector-context"
import { useShallow } from "zustand/react/shallow"
import type { EditorState as WfEditorState } from "@/lib/workflow/editor/store"
import { getWebhookUrl } from "@/lib/workflow/runtime/webhook-bridge"
import { listAdapterInstances } from "@/lib/db/adapter-instances"
import type { TransformersTask } from "@cognia/transformers-runtime/types"

export type Params = Record<string, unknown>

export type ChangeFn = (next: Params) => void

export type TranslationFn = ReturnType<typeof useTranslations>

export interface ConfigProps {
  params: Params
  onChange: ChangeFn
  /**
   * The node's `typeVersion` — forms with a structured v2 params generation
   * (branch/switch) dispatch on it. Omitted by callers that predate the
   * field; treated as 1 (legacy shape).
   */
  typeVersion?: number
}

export function parseObjectJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function parseArrayJson(raw: string): unknown[] | null {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function clampNumberInput(raw: string, min: number, max: number, fallback: number): number {
  const parsed = Math.floor(Number(raw))
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

export function stringifyJsonForTextarea(value: unknown, fallback: unknown): string {
  try {
    return JSON.stringify(value ?? fallback, null, 2)
  } catch {
    return JSON.stringify(fallback, null, 2)
  }
}

export interface PiiGateFieldProps extends Pick<ConfigProps, "params" | "onChange"> {
  id: string
  value: string
  t: TranslationFn
  allowOff?: boolean
}

export function PiiGateField({ id, value, params, onChange, t, allowOff }: PiiGateFieldProps) {
  return (
    <Field label={t("piiGate.label")} htmlFor={id} hint={t("piiGate.hint")} name="piiGate">
      <Select value={value} onValueChange={(next) => onChange(patchParam(params, "piiGate", next))}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {allowOff ? <SelectItem value="off">{t("piiGate.off")}</SelectItem> : null}
          <SelectItem value="block">{t("piiGate.block")}</SelectItem>
          <SelectItem value="redact">{t("piiGate.redact")}</SelectItem>
        </SelectContent>
      </Select>
    </Field>
  )
}

// ── trigger.connector.inbound ─────────────────────────────────────────────
export const CONNECTOR_CHANNEL_KINDS = ["private", "group", "channel", "thread"] as const

export function GoalTemplateIdField({
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

export const PLAN_SOURCES = [
  "manual",
  "agent_tool",
  "planner_llm",
  "team_projection",
  "goal_projection",
  "exit_plan_mode",
] as const

export const PLAN_EXECUTION_MODES = ["auto", "in_session", "orchestrated"] as const

export const PLAN_REFINEMENT_TYPES = [
  "optimize",
  "simplify",
  "expand",
  "reorder",
  "repair",
] as const

export const PLAN_REFINEMENT_TRIGGERS = ["manual", "step_failure", "judge_deviation"] as const

export const PLAN_STATUSES = [
  "draft",
  "awaiting_approval",
  "approved",
  "executing",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const

export const PLAN_STEP_STATUSES = [
  "pending",
  "ready",
  "in_progress",
  "completed",
  "failed",
  "skipped",
  "blocked",
] as const

export const SCHEDULER_TASK_TYPES = [
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

export const SCHEDULER_TRIGGER_TYPES = ["cron", "interval", "once", "event"] as const

export const SCHEDULER_STATUSES = ["active", "paused", "disabled", "expired"] as const

export function PlanIdField({
  params,
  onChange,
  id,
}: {
  params: Params
  onChange: ChangeFn
  id: string
}) {
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

export function patchJsonObjectField(
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

export function readStringRecordJsonParam(
  params: Params,
  rawKey: string,
  objectKey: string
): string {
  const raw = readString(params, rawKey)
  if (raw) return raw
  return stringifyJsonForTextarea(params[objectKey], {})
}

/**
 * Raw-first read for a JSON-array textarea (array analogue of
 * {@link readStringRecordJsonParam}). Returns the raw `rawKey` string verbatim
 * when present so partially-typed / invalid intermediate JSON survives editing;
 * binding the textarea to a re-stringification of the parsed array instead would
 * revert every structural keystroke (the field becomes uneditable by hand).
 */
export function readArrayJsonParam(
  params: Params,
  rawKey: string,
  objectKey: string,
  fallback: unknown
): string {
  const raw = readString(params, rawKey)
  if (raw) return raw
  const value = params[objectKey]
  return stringifyJsonForTextarea(Array.isArray(value) ? value : fallback, fallback)
}

export function patchJsonStringRecordField(
  params: Params,
  rawKey: string,
  rawValue: string,
  objectKey: string
): Params {
  const next = patchParam(params, rawKey, rawValue) as Record<string, unknown>
  const parsed = parseObjectJson(rawValue)
  if (parsed && Object.values(parsed).every((value) => typeof value === "string")) {
    next[objectKey] = parsed as Record<string, string>
  } else {
    delete next[objectKey]
  }
  return next
}

/**
 * Binds one credential slot on the SELECTED NODE to a credential declared in
 * the workflow's settings. The binding lives on `WorkflowNodeData.credentialRefs`
 * (not `params`), which is why this reaches the editor store directly instead of
 * going through the form's `onChange`.
 *
 * Rendered even when the workflow declares nothing — a hidden control would
 * merge "this node cannot use a credential" with "you have not declared one
 * yet", and only the second is true. It says which, and where to fix it.
 */
export function CredentialRefField({
  slot,
  id,
  t,
  inlineValueSet,
}: {
  /** Credential slot name, e.g. `apiKey`. */
  slot: string
  id: string
  t: TranslationFn
  /** True when the sibling plaintext field is filled — it wins at run time. */
  inlineValueSet?: boolean
}) {
  const ctx = useInspectorExpressionCtx()
  const store = ctx?.store
  const nodeId = ctx?.currentNodeId
  // `useShallow` must be called unconditionally (rules of hooks); the store it
  // feeds is only invoked when the provider is mounted, which mirrors how
  // `ExpressionField` reaches the same store.
  // Select the raw reference only. A `?? {}` here would mint a fresh object on
  // every call, which `useShallow` then compares by identity — an infinite
  // render loop for any workflow that has declared no credentials yet.
  const selector = useShallow((s: WfEditorState) => ({
    credentials: s.baseWorkflow.credentials,
    credentialRefs: s.nodes.find((n) => n.id === nodeId)?.data.credentialRefs as
      Record<string, string> | undefined,
  }))
  const state = store?.(selector)

  // No editor store (headless render / story): nothing to bind against.
  if (!ctx || !state) return null

  const declared = Object.values(state.credentials ?? {})
  const current = state.credentialRefs?.[slot] ?? ""

  const commit = (next: string) => {
    const refs = { ...(state.credentialRefs ?? {}) }
    if (next === CREDENTIAL_NONE) delete refs[slot]
    else refs[slot] = next
    store?.getState().updateNodeData(nodeId!, {
      credentialRefs: Object.keys(refs).length > 0 ? refs : undefined,
    })
  }

  return (
    <Field
      label={t("credentialRef.label")}
      htmlFor={id}
      hint={
        declared.length === 0
          ? t("credentialRef.noneDeclared")
          : inlineValueSet && current
            ? t("credentialRef.inlineWins")
            : t("credentialRef.hint")
      }
      name="credentialRef"
    >
      <Select
        value={current || CREDENTIAL_NONE}
        onValueChange={commit}
        disabled={declared.length === 0}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder={t("credentialRef.placeholder")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={CREDENTIAL_NONE}>{t("credentialRef.none")}</SelectItem>
          {declared.map((cred) => (
            <SelectItem key={cred.id} value={cred.id}>
              {cred.name || cred.id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

const CREDENTIAL_NONE = "__credential_none__"

export function AiExplicitProviderFields({
  params,
  onChange,
  t,
  idPrefix,
}: {
  params: Params
  onChange: ChangeFn
  t: TranslationFn
  idPrefix: string
}) {
  const provider = readString(params, "provider")
  const model = readString(params, "model")
  const apiKey = readString(params, "apiKey")
  const baseURL = readString(params, "baseURL")
  const apiFlavor = readString(params, "apiFlavor") || "auto"
  const headersJson = readStringRecordJsonParam(params, "headersJson", "headers")
  return (
    <>
      <FieldRow>
        <Field
          label={t("provider.label")}
          htmlFor={`${idPrefix}-provider`}
          hint={t("provider.hint")}
          name="provider"
        >
          <Input
            id={`${idPrefix}-provider`}
            value={provider}
            onChange={(e) => onChange(patchParam(params, "provider", e.target.value))}
            placeholder={t("provider.placeholder")}
          />
        </Field>
        <Field
          label={t("model.label")}
          htmlFor={`${idPrefix}-model`}
          hint={t("model.hint")}
          name="model"
        >
          <ModelPicker
            id={`${idPrefix}-model`}
            value={model}
            onChange={(v) => onChange(patchParam(params, "model", v))}
            // Picking a model also settles the provider, in one patch. Leaving
            // the two to be typed separately is how a node ends up naming a
            // model its declared provider does not serve.
            onPick={(modelId, providerId) =>
              onChange(patchParam(patchParam(params, "model", modelId), "provider", providerId))
            }
          />
        </Field>
      </FieldRow>
      <Field
        label={t("apiKey.label")}
        htmlFor={`${idPrefix}-key`}
        hint={t("apiKey.hint")}
        name="apiKey"
      >
        <Input
          id={`${idPrefix}-key`}
          type="password"
          value={apiKey}
          onChange={(e) => onChange(patchParam(params, "apiKey", e.target.value))}
        />
      </Field>
      <CredentialRefField
        slot="apiKey"
        id={`${idPrefix}-credential`}
        t={t}
        inlineValueSet={apiKey.length > 0}
      />
      <Field
        label={t("baseURL.label")}
        htmlFor={`${idPrefix}-base`}
        hint={t("baseURL.hint")}
        name="baseURL"
      >
        <Input
          id={`${idPrefix}-base`}
          value={baseURL}
          onChange={(e) => onChange(patchParam(params, "baseURL", e.target.value))}
          placeholder={t("baseURL.placeholder")}
        />
      </Field>
      <Field
        label={t("apiFlavor.label")}
        htmlFor={`${idPrefix}-api-flavor`}
        hint={t("apiFlavor.hint")}
        name="apiFlavor"
      >
        <Select
          value={apiFlavor}
          onValueChange={(value) => onChange(patchParam(params, "apiFlavor", value))}
        >
          <SelectTrigger id={`${idPrefix}-api-flavor`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="auto">{t("apiFlavor.auto")}</SelectItem>
              <SelectItem value="chat">{t("apiFlavor.chat")}</SelectItem>
              <SelectItem value="responses">{t("apiFlavor.responses")}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("headersJson.label")}
        htmlFor={`${idPrefix}-headers`}
        hint={t("headersJson.hint")}
        name="headersJson"
      >
        <Textarea
          id={`${idPrefix}-headers`}
          value={headersJson}
          onChange={(e) =>
            onChange(patchJsonStringRecordField(params, "headersJson", e.target.value, "headers"))
          }
          rows={3}
          className="font-mono text-xs"
          placeholder={t("headersJson.placeholder")}
        />
      </Field>
    </>
  )
}

export function SchedulerTaskIdField({
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

export function SchedulerLimitConfig({
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

export function SchedulerTaskJsonFields({
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
  // Only the update node can clear an end date: `buildSchedulerUpdateInput`
  // maps `clearEndAt` to `endAt: null`, and when it is set the `endAt` string
  // is ignored entirely — so the input is disabled rather than left looking
  // live.
  const canClearEndAt = namespace === "schedulerTaskUpdate"
  const clearEndAt = canClearEndAt && readBoolean(params, "clearEndAt", false)
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
          disabled={clearEndAt}
          onChange={(e) => onChange(patchParam(params, "endAt", e.target.value))}
        />
      </Field>
      {canClearEndAt ? (
        <Field
          label={t("clearEndAt.label")}
          htmlFor={`${idPrefix}-clear-end-at`}
          hint={t("clearEndAt.hint")}
          name="clearEndAt"
        >
          <Switch
            id={`${idPrefix}-clear-end-at`}
            checked={clearEndAt}
            onCheckedChange={(v) =>
              onChange(patchParam(params, "clearEndAt", v === true ? true : undefined))
            }
            aria-label={t("clearEndAt.label")}
          />
        </Field>
      ) : null}
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

// ── ai.council ────────────────────────────────────────────────────────────
export const DEFAULT_COUNCILLORS = [
  { name: "Reviewer", modelAlias: "smart" },
  { name: "Fast pass", modelAlias: "fast" },
]

// ── ai.ensemble ───────────────────────────────────────────────────────────
export const ENSEMBLE_AGG_DEFAULTS: Record<string, Record<string, unknown>> = {
  "majority-vote-on-field": { kind: "majority-vote-on-field", field: "" },
  "threshold-count": { kind: "threshold-count", field: "", threshold: 2 },
  "best-of-by-score": { kind: "best-of-by-score", scoreField: "" },
  "synthesize-by-final-agent": { kind: "synthesize-by-final-agent" },
}

/** typeVersion 2 — structured condition group routing to true/false handles. */
export function BranchConfigV2({ params, onChange }: { params: Params; onChange: ChangeFn }) {
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

export function BranchConfigV1({
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
      <FieldRow>
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
      </FieldRow>
    </FieldGroup>
  )
}

// ── annotation.note ───────────────────────────────────────────────────────
export const NOTE_COLOR_OPTIONS: Array<{
  value: "yellow" | "green" | "blue" | "pink" | "violet"
  swatch: string
}> = [
  { value: "yellow", swatch: "bg-amber-200" },
  { value: "green", swatch: "bg-emerald-200" },
  { value: "blue", swatch: "bg-sky-200" },
  { value: "pink", swatch: "bg-pink-200" },
  { value: "violet", swatch: "bg-violet-200" },
]

// Banner that fetches the live webhook URL for the current node and shows
// it (or a "save first" hint when the trigger hasn't been registered yet).
export function WebhookUrlBanner() {
  const t = useTranslations("workflows.forms.webhookBanner")
  const ctx = useInspectorExpressionCtx()
  const [url, setUrl] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const triggerId = ctx?.currentNodeId
  const workflowId = ctx?.store.getState().baseWorkflow.id
  useEffect(() => {
    if (!workflowId || !triggerId) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPending(true)
    void getWebhookUrl(workflowId, triggerId)
      .then((u) => {
        if (!cancelled) setUrl(u)
      })
      .finally(() => {
        if (!cancelled) setPending(false)
      })
    return () => {
      cancelled = true
    }
  }, [triggerId, workflowId])
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

// ── action.mobile.* (ADR 0061 P3) ─────────────────────────────────────────
// Shared routing fields: pin a paired device + bound the wait.
export function MobileRoutingFields({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.mobileStep")
  const deviceId = readString(params, "deviceId")
  const timeoutMs = readNumber(params, "timeoutMs", 120_000)
  return (
    <FieldRow>
      <Field
        label={t("deviceId.label")}
        htmlFor="mob-device"
        hint={t("deviceId.hint")}
        name="deviceId"
      >
        <Input
          id="mob-device"
          value={deviceId}
          onChange={(e) => onChange(patchParam(params, "deviceId", e.target.value))}
        />
      </Field>
      <Field label={t("timeoutMs.label")} htmlFor="mob-timeout" name="timeoutMs">
        <Input
          id="mob-timeout"
          type="number"
          min={1000}
          value={timeoutMs}
          onChange={(e) =>
            onChange(patchParam(params, "timeoutMs", Number(e.target.value) || 120_000))
          }
        />
      </Field>
    </FieldRow>
  )
}

export const BROWSER_MODEL_TASKS: readonly TransformersTask[] = [
  "text-classification",
  "translation",
  "summarization",
  "text-generation",
  "text2text-generation",
  "question-answering",
  "zero-shot-classification",
  "token-classification",
  "fill-mask",
  "feature-extraction",
  "sentence-similarity",
  "automatic-speech-recognition",
  "image-classification",
  "object-detection",
  "image-to-text",
  "image-segmentation",
  "depth-estimation",
  "text-to-speech",
]

export interface SwitchCaseV2 {
  id: string
  label?: string
  when: WorkflowConditionGroup
}

/** typeVersion 2 — ordered cases, each with a stable id + condition group. */
export function SwitchConfigV2({ params, onChange }: { params: Params; onChange: ChangeFn }) {
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

export function SwitchConfigV1({ params, onChange }: { params: Params; onChange: ChangeFn }) {
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

/** typeVersion 2 — container sub-canvas (body nodes live inside the loop). */
export function LoopConfigV2({ params, onChange }: { params: Params; onChange: ChangeFn }) {
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
  const authoredOnItemError = readString(params, "onItemError", "fail")
  const onItemError = authoredOnItemError === "skip" ? "remove-failed" : authoredOnItemError
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
            <SelectItem value="continue-with-null">{t("onItemError.continueWithNull")}</SelectItem>
            <SelectItem value="remove-failed">{t("onItemError.removeFailed")}</SelectItem>
            <SelectItem value="break">{t("onItemError.break")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </FieldGroup>
  )
}

export function LoopConfigV1({ params, onChange }: { params: Params; onChange: ChangeFn }) {
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

// ── trigger.desktop.event ─────────────────────────────────────────────────
// Desktop-only. Multi-selects the UIA event kinds the executor reads from
// `params.kinds` (see `lib/automation/types.ts:EventKind`).
export const DESKTOP_EVENT_KINDS = [
  "focus-changed",
  "structure-changed",
  "property-changed",
] as const

// ── trigger.connector.system ──────────────────────────────────────────────
// Platform system-event kinds the connector bus surfaces (`applySystemEvent`).
// Single source of truth is the params schema so the form and the validator
// can never drift.
export { CONNECTOR_SYSTEM_EVENT_KINDS } from "@/lib/workflow/nodes/params-schemas"

// ── trigger.pet.event ─────────────────────────────────────────────────────
// Pet lifecycle event bridge. Mirrors `lib/workflow/runtime/pet-event-trigger.ts`.
export const PET_EVENT_KINDS = ["levelUp", "evolved", "achievementUnlocked", "unwell"] as const

// ── action.pet.interact ───────────────────────────────────────────────────
export const PET_INTERACTION_KINDS = [
  "fed",
  "played",
  "petted",
  "talked",
  "slept",
  "cleaned",
  "treated",
] as const

/**
 * Shared unattended-mode controls (`action.system.terminal` +
 * `action.terminal.session.*`): the headless toggle and, while it is on,
 * the ask-verdict policy. Keys live under `workflows.forms.terminalUnattended`.
 */
export function TerminalUnattendedFields({
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

// Suppress unused-import warnings when only one of these helpers is exercised
// in a given form's tests. They're real call sites in production.
void listAdapterInstances
