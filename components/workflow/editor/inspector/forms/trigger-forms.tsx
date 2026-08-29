"use client"

import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
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
import {
  AdapterInstancePicker,
  CharacterPicker,
  TeamPicker,
  SubworkflowPicker,
} from "./shared/entity-picker"
import { CronBuilder } from "./shared/cron-builder"
import { OutputSchemaField } from "./output-schema-field"
import {
  CONNECTOR_CHANNEL_KINDS,
  CONNECTOR_SYSTEM_EVENT_KINDS,
  DESKTOP_EVENT_KINDS,
  PET_EVENT_KINDS,
  WebhookUrlBanner,
  clampNumberInput,
} from "./form-support"
import type { ConfigProps } from "./form-support"

// ── trigger.manual ────────────────────────────────────────────────────────
export function ManualTriggerConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.manualTrigger")
  return (
    <FieldGroup>
      <p className="text-xs text-muted-foreground">{t("intro")}</p>
      {/* Declared input schema (D5): the published interface's run payload,
          surfaced to nodes as $trigger.payload. */}
      <Field label={t("inputSchema.label")} hint={t("inputSchema.hint")} name="inputSchema">
        <OutputSchemaField
          value={
            params.inputSchema && typeof params.inputSchema === "object"
              ? (params.inputSchema as Record<string, unknown>)
              : undefined
          }
          onChange={(next) => onChange(patchParam(params, "inputSchema", next))}
          idPrefix="mt"
        />
      </Field>
    </FieldGroup>
  )
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

export function ConnectorInboundConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.connectorInbound")
  const adapterId = readString(params, "adapterId")
  const conversationKey = readString(params, "conversationKey")
  const characterId = readString(params, "characterId")
  const senderIds = Array.isArray(params.senderIds) ? (params.senderIds as string[]).join(", ") : ""
  const keywords = Array.isArray(params.keywords) ? (params.keywords as string[]).join(", ") : ""
  const channelKinds = Array.isArray(params.channelKinds) ? (params.channelKinds as string[]) : []
  const requireMention = readBoolean(params, "requireMention", false)
  const patchList = (key: string, raw: string) => {
    const list = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    onChange(patchParam(params, key, list.length > 0 ? list : undefined))
  }
  const toggleChannelKind = (kind: string) => {
    const next = channelKinds.includes(kind)
      ? channelKinds.filter((k) => k !== kind)
      : [...channelKinds, kind]
    onChange(patchParam(params, "channelKinds", next.length > 0 ? next : undefined))
  }
  return (
    <FieldGroup>
      <Field
        label={t("adapter.label")}
        htmlFor="ci-adapter"
        hint={t("adapter.hint")}
        name="adapterId"
        required
      >
        <AdapterInstancePicker
          id="ci-adapter"
          value={adapterId}
          onChange={(v) => onChange(patchParam(params, "adapterId", v))}
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
      <Field
        label={t("senderIds.label")}
        htmlFor="ci-senders"
        hint={t("senderIds.hint")}
        name="senderIds"
      >
        <Input
          id="ci-senders"
          value={senderIds}
          onChange={(e) => patchList("senderIds", e.target.value)}
          placeholder={t("senderIds.placeholder")}
        />
      </Field>
      <Field
        label={t("keywords.label")}
        htmlFor="ci-keywords"
        hint={t("keywords.hint")}
        name="keywords"
      >
        <Input
          id="ci-keywords"
          value={keywords}
          onChange={(e) => patchList("keywords", e.target.value)}
          placeholder={t("keywords.placeholder")}
        />
      </Field>
      <Field label={t("channelKinds.label")} hint={t("channelKinds.hint")} name="channelKinds">
        <div className="space-y-1.5">
          {CONNECTOR_CHANNEL_KINDS.map((kind) => (
            <label
              key={kind}
              className="flex items-center gap-2 rounded-md border bg-muted/20 px-2 py-1.5 text-sm hover:bg-muted/40"
            >
              <Checkbox
                checked={channelKinds.includes(kind)}
                onCheckedChange={() => toggleChannelKind(kind)}
                data-testid={`ci-channel-${kind}`}
              />
              <span>{t(`channelKinds.options.${kind}` as never)}</span>
            </label>
          ))}
        </div>
      </Field>
      <Field label={t("requireMention.label")} name="requireMention">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={requireMention}
            onCheckedChange={(v) =>
              onChange(patchParam(params, "requireMention", v === true ? true : undefined))
            }
            data-testid="ci-require-mention"
          />
          <span className="text-muted-foreground">{t("requireMention.hint")}</span>
        </label>
      </Field>
    </FieldGroup>
  )
}

// ── trigger.connector.system ─────────────────────────────────────────────
export function ConnectorSystemTriggerConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.connectorSystem")
  const adapterId = readString(params, "adapterId")
  const conversationKey = readString(params, "conversationKey")
  const kinds = Array.isArray(params.kinds) ? (params.kinds as string[]) : []
  const targetSelfOnly = readBoolean(params, "targetSelfOnly", false)
  const toggleKind = (kind: string) => {
    const next = kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind]
    onChange(patchParam(params, "kinds", next.length > 0 ? next : undefined))
  }
  return (
    <FieldGroup>
      <Field
        label={t("adapter.label")}
        htmlFor="cs-adapter"
        hint={t("adapter.hint")}
        name="adapterId"
        required
      >
        <AdapterInstancePicker
          id="cs-adapter"
          value={adapterId}
          onChange={(v) => onChange(patchParam(params, "adapterId", v))}
        />
      </Field>
      <Field
        label={t("conversationKey.label")}
        htmlFor="cs-conv"
        hint={t("conversationKey.hint")}
        name="conversationKey"
      >
        <Input
          id="cs-conv"
          value={conversationKey}
          onChange={(e) => onChange(patchParam(params, "conversationKey", e.target.value))}
        />
      </Field>
      <Field label={t("kinds.label")} hint={t("kinds.hint")} name="kinds">
        <div className="space-y-1.5">
          {CONNECTOR_SYSTEM_EVENT_KINDS.map((kind) => (
            <label
              key={kind}
              className="flex items-center gap-2 rounded-md border bg-muted/20 px-2 py-1.5 text-sm hover:bg-muted/40"
            >
              <Checkbox
                checked={kinds.includes(kind)}
                onCheckedChange={() => toggleKind(kind)}
                data-testid={`cs-kind-${kind}`}
              />
              <span>{t(`kinds.options.${kind}` as never)}</span>
            </label>
          ))}
        </div>
      </Field>
      <Field label={t("targetSelfOnly.label")} name="targetSelfOnly">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={targetSelfOnly}
            onCheckedChange={(v) =>
              onChange(patchParam(params, "targetSelfOnly", v === true ? true : undefined))
            }
            data-testid="cs-target-self-only"
          />
          <span className="text-muted-foreground">{t("targetSelfOnly.hint")}</span>
        </label>
      </Field>
    </FieldGroup>
  )
}

// ── trigger.integration.event ────────────────────────────────────────────
export function IntegrationEventTriggerConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.integrationEventTrigger")
  const eventTypes = Array.isArray(params.eventTypes)
    ? (params.eventTypes as string[]).join(", ")
    : ""
  const patchEventTypes = (raw: string) => {
    const next = raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
    onChange(patchParam(params, "eventTypes", next.length > 0 ? next : undefined))
  }

  return (
    <FieldGroup>
      {(
        [
          ["pluginId", "integration-plugin"],
          ["integrationId", "integration-definition"],
          ["accountId", "integration-account"],
          ["resourceKind", "integration-resource-kind"],
          ["resourceId", "integration-resource-id"],
        ] as const
      ).map(([name, id]) => (
        <Field
          key={name}
          label={t(`${name}.label`)}
          hint={t(`${name}.hint`)}
          htmlFor={id}
          name={name}
        >
          <Input
            id={id}
            value={readString(params, name)}
            onChange={(event) => onChange(patchParam(params, name, event.target.value))}
            placeholder={t(`${name}.placeholder`)}
          />
        </Field>
      ))}
      <Field
        label={t("eventTypes.label")}
        hint={t("eventTypes.hint")}
        htmlFor="integration-event-types"
        name="eventTypes"
      >
        <Input
          id="integration-event-types"
          value={eventTypes}
          onChange={(event) => patchEventTypes(event.target.value)}
          placeholder={t("eventTypes.placeholder")}
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

// ── trigger.workflow.completed ────────────────────────────────────────────
export function WorkflowCompletedTriggerConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.workflowCompletedTrigger")
  const workflowId = readString(params, "workflowId")
  const status = readString(params, "status", "any")
  return (
    <FieldGroup>
      <Field
        label={t("workflowId.label")}
        htmlFor="wc-workflow"
        hint={t("workflowId.hint")}
        name="workflowId"
      >
        <SubworkflowPicker
          id="wc-workflow"
          value={workflowId}
          onChange={(v) => onChange(patchParam(params, "workflowId", v))}
        />
      </Field>
      <Field label={t("status.label")} htmlFor="wc-status" hint={t("status.hint")} name="status">
        <Select
          value={status}
          onValueChange={(v) =>
            // "any" = no filter — store the param as absent, matching the
            // params schema (status is a succeeded/failed enum when present).
            onChange(patchParam(params, "status", v === "any" ? "" : v))
          }
        >
          <SelectTrigger id="wc-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">{t("status.options.any")}</SelectItem>
            <SelectItem value="succeeded">{t("status.options.succeeded")}</SelectItem>
            <SelectItem value="failed">{t("status.options.failed")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </FieldGroup>
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
      <FieldRow>
        <Field label={t("method.label")} htmlFor="wh-method" name="method">
          <Select value={method} onValueChange={(v) => onChange(patchParam(params, "method", v))}>
            <SelectTrigger id="wh-method">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* i18n-exempt: HTTP method name (protocol keyword), not UI prose */}
              <SelectItem value="POST">POST</SelectItem>
              {/* i18n-exempt: HTTP method name (protocol keyword), not UI prose */}
              <SelectItem value="GET">GET</SelectItem>
              {/* i18n-exempt: HTTP method name (protocol keyword), not UI prose */}
              <SelectItem value="PUT">PUT</SelectItem>
              {/* i18n-exempt: HTTP method name (protocol keyword), not UI prose */}
              <SelectItem value="PATCH">PATCH</SelectItem>
              {/* i18n-exempt: HTTP method name (protocol keyword), not UI prose */}
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
      </FieldRow>
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
      <FieldRow columns={3}>
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
      </FieldRow>
    </FieldGroup>
  )
}

// Entity pickers (Character/Team/Skill/McpServer/Plugin/Subworkflow/Twin) now
// live in `./shared/entity-picker` as searchable comboboxes — imported above.

// ── trigger.team ──────────────────────────────────────────────────────────
// "On team finished" — fires from runTeamLifecycle's terminal fan-out.
// Optional scoping by team and terminal status; unscoped fires for every
// team run. (The kind doubles as the synthesizer's internal run marker,
// which carries no `event` field and never matches user workflows.)
export function TeamTriggerConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.teamTrigger")
  const teamId = readString(params, "teamId")
  const status = readString(params, "status")
  const ANY = "__any__"
  return (
    <FieldGroup>
      <p className="text-xs text-muted-foreground">{t("intro")}</p>
      <Field label={t("teamId.label")} htmlFor="tt-team" hint={t("teamId.hint")} name="teamId">
        <TeamPicker
          id="tt-team"
          value={teamId}
          onChange={(v) => onChange(patchParam(params, "teamId", v))}
        />
      </Field>
      <Field label={t("status.label")} htmlFor="tt-status" hint={t("status.hint")} name="status">
        <Select
          value={status || ANY}
          onValueChange={(v) => onChange(patchParam(params, "status", v === ANY ? "" : v))}
        >
          <SelectTrigger id="tt-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{t("status.options.any")}</SelectItem>
            <SelectItem value="completed">{t("status.options.completed")}</SelectItem>
            <SelectItem value="failed">{t("status.options.failed")}</SelectItem>
            <SelectItem value="cancelled">{t("status.options.cancelled")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </FieldGroup>
  )
}

export function DesktopEventTriggerConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.desktopEventTrigger")
  const selected = Array.isArray(params.kinds) ? (params.kinds as string[]) : []
  const scope =
    typeof params.scope === "string"
      ? params.scope
      : Array.isArray(params.scope) && typeof params.scope[0] === "string"
        ? params.scope[0]
        : ""
  const cooldownMs = readNumber(params, "cooldownMs", 2000)
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
      <Field label={t("scope.label")} htmlFor="det-scope" hint={t("scope.hint")} name="scope">
        <Input
          id="det-scope"
          value={scope}
          placeholder={t("scope.placeholder")}
          data-testid="desktop-event-scope"
          onChange={(e) => onChange(patchParam(params, "scope", e.target.value || undefined))}
        />
      </Field>
      <Field
        label={t("cooldownMs.label")}
        htmlFor="det-cooldown"
        hint={t("cooldownMs.hint")}
        name="cooldownMs"
      >
        <Input
          id="det-cooldown"
          type="number"
          min={0}
          value={cooldownMs}
          data-testid="desktop-event-cooldown"
          onChange={(e) =>
            onChange(patchParam(params, "cooldownMs", Math.max(0, Number(e.target.value) || 0)))
          }
        />
      </Field>
    </FieldGroup>
  )
}

export function PetEventTriggerConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.petEventTrigger")
  const selected = Array.isArray(params.kinds) ? (params.kinds as string[]) : []
  const cooldownMs = readNumber(params, "cooldownMs", 2000)
  const toggle = (kind: string) => {
    const next = selected.includes(kind) ? selected.filter((k) => k !== kind) : [...selected, kind]
    onChange(patchParam(params, "kinds", next))
  }
  return (
    <FieldGroup>
      <p className="text-xs text-muted-foreground">{t("intro")}</p>
      <Field label={t("kinds.label")} hint={t("kinds.hint")} name="kinds">
        <div className="space-y-1.5">
          {PET_EVENT_KINDS.map((kind) => (
            <label
              key={kind}
              className="flex items-center gap-2 rounded-md border bg-muted/20 px-2 py-1.5 text-sm hover:bg-muted/40"
            >
              <Checkbox
                checked={selected.includes(kind)}
                onCheckedChange={() => toggle(kind)}
                data-testid={`pet-event-${kind}`}
              />
              <span>{t(`kinds.options.${kind}` as never)}</span>
            </label>
          ))}
        </div>
      </Field>
      <Field
        label={t("cooldownMs.label")}
        htmlFor="pet-event-cooldown"
        hint={t("cooldownMs.hint")}
        name="cooldownMs"
      >
        <Input
          id="pet-event-cooldown"
          type="number"
          min={0}
          max={300000}
          value={cooldownMs}
          onChange={(e) =>
            onChange(
              patchParam(params, "cooldownMs", clampNumberInput(e.target.value, 0, 300000, 2000))
            )
          }
        />
      </Field>
    </FieldGroup>
  )
}
