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
import { useInspectorExpressionCtx } from "./shared/inspector-context"
import { getWebhookUrl } from "@/lib/workflow/runtime/webhook-bridge"
import { listAdapterInstances } from "@/lib/db/adapter-instances"
import {
  CharacterPicker,
  TeamPicker,
  SkillPicker,
  McpServerPicker,
  PluginPicker,
  SubworkflowPicker,
  TwinPicker,
} from "./shared/entity-picker"
import { CronBuilder } from "./shared/cron-builder"
import { DurationField } from "./shared/duration-field"

type Params = Record<string, unknown>
type ChangeFn = (next: Params) => void

interface ConfigProps {
  params: Params
  onChange: ChangeFn
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
export function AiPromptConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.aiPrompt")
  const provider = readString(params, "provider")
  const model = readString(params, "model")
  const apiKey = readString(params, "apiKey")
  const baseURL = readString(params, "baseURL")
  const systemPrompt = readString(params, "systemPrompt")
  const userPrompt = readString(params, "userPrompt")
  const temperature = readNumber(params, "temperature", 0.7)
  return (
    <FieldGroup>
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
      <Field label={t("baseURL.label")} htmlFor="ai-base" hint={t("baseURL.hint")} name="baseURL">
        <Input
          id="ai-base"
          value={baseURL}
          onChange={(e) => onChange(patchParam(params, "baseURL", e.target.value))}
          placeholder={t("baseURL.placeholder")}
        />
      </Field>
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
    </FieldGroup>
  )
}

// ── flow.branch ───────────────────────────────────────────────────────────
export function BranchConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.branch")
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
        <Input
          id="mi-tool"
          value={toolName}
          onChange={(e) => onChange(patchParam(params, "toolName", e.target.value))}
          placeholder={t("toolName.placeholder")}
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
export function PluginInvokeConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.pluginInvoke")
  const pluginId = readString(params, "pluginId")
  const taskId = readString(params, "taskId")
  const argsJson = readString(params, "argsJson", "{}")
  return (
    <FieldGroup>
      <Field label={t("pluginId.label")} htmlFor="pi-plug" name="pluginId" required>
        <PluginPicker
          id="pi-plug"
          value={pluginId}
          onChange={(v) => onChange(patchParam(params, "pluginId", v))}
        />
      </Field>
      <Field label={t("taskId.label")} htmlFor="pi-task" name="taskId" required>
        <Input
          id="pi-task"
          value={taskId}
          onChange={(e) => onChange(patchParam(params, "taskId", e.target.value))}
          placeholder={t("taskId.placeholder")}
        />
      </Field>
      <Field
        label={t("argsJson.label")}
        htmlFor="pi-args"
        hint={t("argsJson.hint")}
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
  return (
    <FieldGroup>
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
export function SwitchConfig({ params, onChange }: ConfigProps) {
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
export function LoopConfig({ params, onChange }: ConfigProps) {
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
    </FieldGroup>
  )
}

// Suppress unused-import warnings when only one of these helpers is exercised
// in a given form's tests. They're real call sites in production.
void listAdapterInstances
