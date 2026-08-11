"use client"

import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Field, FieldGroup, readBoolean, readNumber, readString, patchParam } from "./shared"
import { AdapterInstancePicker } from "./shared/entity-picker"
import { PiiGateField, clampNumberInput } from "./form-support"
import type { ConfigProps } from "./form-support"

// ── action.connector.send ─────────────────────────────────────────────────
export function ConnectorSendConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.connectorSend")
  const cardJson = readString(params, "cardJson")
  const replyToMessageId = readString(params, "replyToMessageId")
  const threadId = readString(params, "threadId")
  const idempotencyKey = readString(params, "idempotencyKey")
  const editTargetMessageId = readString(params, "editTargetMessageId")
  const waitForDelivery = readBoolean(params, "waitForDelivery", false)
  const waitTimeoutMs = readNumber(params, "waitTimeoutMs", 30000)
  const adapterId = readString(params, "adapterId")
  const conversationKey = readString(params, "conversationKey")
  const content = readString(params, "content")
  const piiGate = readString(params, "piiGate", "block")
  return (
    <FieldGroup>
      <Field label={t("adapter.label")} htmlFor="cs-adapter" name="adapterId" required>
        <AdapterInstancePicker
          id="cs-adapter"
          value={adapterId}
          onChange={(v) => onChange(patchParam(params, "adapterId", v))}
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
      <PiiGateField id="cs-pii" value={piiGate} params={params} onChange={onChange} t={t} />
      <Field
        label={t("cardJson.label")}
        htmlFor="cs-card-json"
        hint={t("cardJson.hint")}
        name="cardJson"
      >
        <Textarea
          id="cs-card-json"
          value={cardJson}
          onChange={(e) => onChange(patchParam(params, "cardJson", e.target.value))}
          rows={4}
          placeholder={t("cardJson.placeholder")}
          className="font-mono text-xs"
        />
      </Field>
      <Field
        label={t("replyTo.label")}
        htmlFor="cs-reply-to"
        hint={t("replyTo.hint")}
        name="replyToMessageId"
      >
        <Input
          id="cs-reply-to"
          value={replyToMessageId}
          onChange={(e) => onChange(patchParam(params, "replyToMessageId", e.target.value))}
          placeholder={t("replyTo.placeholder")}
        />
      </Field>
      <Field
        label={t("threadId.label")}
        htmlFor="cs-thread"
        hint={t("threadId.hint")}
        name="threadId"
      >
        <Input
          id="cs-thread"
          value={threadId}
          onChange={(e) => onChange(patchParam(params, "threadId", e.target.value))}
        />
      </Field>
      <Field
        label={t("editTarget.label")}
        htmlFor="cs-edit-target"
        hint={t("editTarget.hint")}
        name="editTargetMessageId"
      >
        <Input
          id="cs-edit-target"
          value={editTargetMessageId}
          onChange={(e) => onChange(patchParam(params, "editTargetMessageId", e.target.value))}
          placeholder={t("editTarget.placeholder")}
        />
      </Field>
      <Field
        label={t("idempotencyKey.label")}
        htmlFor="cs-idem"
        hint={t("idempotencyKey.hint")}
        name="idempotencyKey"
      >
        <Input
          id="cs-idem"
          value={idempotencyKey}
          onChange={(e) => onChange(patchParam(params, "idempotencyKey", e.target.value))}
        />
      </Field>
      <Field label={t("waitForDelivery.label")} name="waitForDelivery">
        <div className="flex items-center gap-2 text-xs">
          <Switch
            checked={waitForDelivery}
            onCheckedChange={(v) =>
              onChange(patchParam(params, "waitForDelivery", v === true ? true : undefined))
            }
          />
          <span className="text-muted-foreground">{t("waitForDelivery.hint")}</span>
        </div>
      </Field>
      {waitForDelivery ? (
        <Field
          label={t("waitTimeoutMs.label")}
          htmlFor="cs-wait-timeout"
          hint={t("waitTimeoutMs.hint")}
          name="waitTimeoutMs"
        >
          <Input
            id="cs-wait-timeout"
            type="number"
            min={100}
            max={300000}
            value={waitTimeoutMs}
            onChange={(e) =>
              onChange(
                patchParam(
                  params,
                  "waitTimeoutMs",
                  clampNumberInput(e.target.value, 100, 300000, 30000)
                )
              )
            }
          />
        </Field>
      ) : null}
    </FieldGroup>
  )
}

// ── action.connector.reaction ─────────────────────────────────────────────
export function ConnectorReactionConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.connectorReaction")
  const adapterId = readString(params, "adapterId")
  const messageId = readString(params, "messageId")
  const emoji = readString(params, "emoji")
  const op = readString(params, "op", "add")
  const reactionId = readString(params, "reactionId")
  return (
    <FieldGroup>
      <Field label={t("adapter.label")} htmlFor="cr-adapter" name="adapterId" required>
        <AdapterInstancePicker
          id="cr-adapter"
          value={adapterId}
          onChange={(v) => onChange(patchParam(params, "adapterId", v))}
        />
      </Field>
      <Field label={t("op.label")} htmlFor="cr-op" name="op">
        <Select value={op} onValueChange={(v) => onChange(patchParam(params, "op", v))}>
          <SelectTrigger id="cr-op">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="add">{t("op.options.add")}</SelectItem>
            <SelectItem value="remove">{t("op.options.remove")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("messageId.label")}
        htmlFor="cr-message"
        hint={t("messageId.hint")}
        name="messageId"
        required
      >
        <Input
          id="cr-message"
          value={messageId}
          onChange={(e) => onChange(patchParam(params, "messageId", e.target.value))}
          placeholder={t("messageId.placeholder")}
        />
      </Field>
      {op === "remove" ? (
        <Field
          label={t("reactionId.label")}
          htmlFor="cr-reaction"
          hint={t("reactionId.hint")}
          name="reactionId"
          required
        >
          <Input
            id="cr-reaction"
            value={reactionId}
            onChange={(e) => onChange(patchParam(params, "reactionId", e.target.value))}
            placeholder={t("reactionId.placeholder")}
          />
        </Field>
      ) : (
        <Field
          label={t("emoji.label")}
          htmlFor="cr-emoji"
          hint={t("emoji.hint")}
          name="emoji"
          required
        >
          <Input
            id="cr-emoji"
            value={emoji}
            onChange={(e) => onChange(patchParam(params, "emoji", e.target.value))}
            placeholder={t("emoji.placeholder")}
          />
        </Field>
      )}
    </FieldGroup>
  )
}

// ── action.connector.delete ───────────────────────────────────────────────
export function ConnectorDeleteConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.connectorDelete")
  const adapterId = readString(params, "adapterId")
  const messageId = readString(params, "messageId")
  return (
    <FieldGroup>
      <Field label={t("adapter.label")} htmlFor="cd-adapter" name="adapterId" required>
        <AdapterInstancePicker
          id="cd-adapter"
          value={adapterId}
          onChange={(v) => onChange(patchParam(params, "adapterId", v))}
        />
      </Field>
      <Field
        label={t("messageId.label")}
        htmlFor="cd-message"
        hint={t("messageId.hint")}
        name="messageId"
        required
      >
        <Input
          id="cd-message"
          value={messageId}
          onChange={(e) => onChange(patchParam(params, "messageId", e.target.value))}
          placeholder={t("messageId.placeholder")}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.connector.forward ──────────────────────────────────────────────
export function ConnectorForwardConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.connectorForward")
  const adapterId = readString(params, "adapterId")
  const messageId = readString(params, "messageId")
  const target = readString(params, "targetConversationKey")
  const piiGate = readString(params, "piiGate", "block")
  return (
    <FieldGroup>
      <Field label={t("adapter.label")} htmlFor="cf-adapter" name="adapterId" required>
        <AdapterInstancePicker
          id="cf-adapter"
          value={adapterId}
          onChange={(v) => onChange(patchParam(params, "adapterId", v))}
        />
      </Field>
      <Field
        label={t("messageId.label")}
        htmlFor="cf-message"
        hint={t("messageId.hint")}
        name="messageId"
        required
      >
        <Input
          id="cf-message"
          value={messageId}
          onChange={(e) => onChange(patchParam(params, "messageId", e.target.value))}
          placeholder={t("messageId.placeholder")}
        />
      </Field>
      <Field
        label={t("target.label")}
        htmlFor="cf-target"
        hint={t("target.hint")}
        name="targetConversationKey"
        required
      >
        <Input
          id="cf-target"
          value={target}
          onChange={(e) => onChange(patchParam(params, "targetConversationKey", e.target.value))}
          placeholder={t("target.placeholder")}
        />
      </Field>
      <PiiGateField id="cf-pii" value={piiGate} params={params} onChange={onChange} t={t} />
    </FieldGroup>
  )
}

// ── action.connector.waitReply ────────────────────────────────────────────
export function ConnectorWaitReplyConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.connectorWaitReply")
  const conversationKey = readString(params, "conversationKey")
  const senderIds = Array.isArray(params.senderIds) ? (params.senderIds as string[]).join(", ") : ""
  const keywords = Array.isArray(params.keywords) ? (params.keywords as string[]).join(", ") : ""
  const requireMention = readBoolean(params, "requireMention", false)
  const timeoutMs = readNumber(params, "timeoutMs", 120000)
  const patchList = (key: string, raw: string) => {
    const list = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    onChange(patchParam(params, key, list.length > 0 ? list : undefined))
  }
  return (
    <FieldGroup>
      <Field
        label={t("conversationKey.label")}
        htmlFor="cw-conv"
        hint={t("conversationKey.hint")}
        name="conversationKey"
        required
      >
        <Input
          id="cw-conv"
          value={conversationKey}
          onChange={(e) => onChange(patchParam(params, "conversationKey", e.target.value))}
        />
      </Field>
      <Field
        label={t("senderIds.label")}
        htmlFor="cw-senders"
        hint={t("senderIds.hint")}
        name="senderIds"
      >
        <Input
          id="cw-senders"
          value={senderIds}
          onChange={(e) => patchList("senderIds", e.target.value)}
          placeholder={t("senderIds.placeholder")}
        />
      </Field>
      <Field
        label={t("keywords.label")}
        htmlFor="cw-keywords"
        hint={t("keywords.hint")}
        name="keywords"
      >
        <Input
          id="cw-keywords"
          value={keywords}
          onChange={(e) => patchList("keywords", e.target.value)}
          placeholder={t("keywords.placeholder")}
        />
      </Field>
      <Field label={t("requireMention.label")} name="requireMention">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={requireMention}
            onCheckedChange={(v) =>
              onChange(patchParam(params, "requireMention", v === true ? true : undefined))
            }
          />
          <span className="text-muted-foreground">{t("requireMention.hint")}</span>
        </label>
      </Field>
      <Field
        label={t("timeoutMs.label")}
        htmlFor="cw-timeout"
        hint={t("timeoutMs.hint")}
        name="timeoutMs"
      >
        <Input
          id="cw-timeout"
          type="number"
          min={1000}
          max={3600000}
          value={timeoutMs}
          onChange={(e) =>
            onChange(
              patchParam(
                params,
                "timeoutMs",
                clampNumberInput(e.target.value, 1000, 3600000, 120000)
              )
            )
          }
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
