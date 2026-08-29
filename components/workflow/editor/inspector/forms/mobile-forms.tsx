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
import { MobileRoutingFields } from "./form-support"
import type { ConfigProps } from "./form-support"

// ── action.approval.request ───────────────────────────────────────────────
export function ApprovalRequestConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.approvalRequest")
  const title = readString(params, "title")
  const message = readString(params, "message")
  const timeoutMs = readNumber(params, "timeoutMs", 3_600_000)
  const onTimeout = readString(params, "onTimeout", "reject")
  return (
    <FieldGroup>
      <Field label={t("title.label")} htmlFor="apr-title" name="title" required>
        <Input
          id="apr-title"
          value={title}
          onChange={(e) => onChange(patchParam(params, "title", e.target.value))}
        />
      </Field>
      <Field label={t("message.label")} htmlFor="apr-message" name="message">
        <Textarea
          id="apr-message"
          value={message}
          onChange={(e) => onChange(patchParam(params, "message", e.target.value))}
          rows={3}
        />
      </Field>
      <FieldRow>
        <Field
          label={t("timeoutMs.label")}
          htmlFor="apr-timeout"
          hint={t("timeoutMs.hint")}
          name="timeoutMs"
        >
          <Input
            id="apr-timeout"
            type="number"
            min={1000}
            value={timeoutMs}
            onChange={(e) =>
              onChange(patchParam(params, "timeoutMs", Number(e.target.value) || 3_600_000))
            }
          />
        </Field>
        <Field label={t("onTimeout.label")} htmlFor="apr-ontimeout" name="onTimeout">
          <Select
            value={onTimeout}
            onValueChange={(v) => onChange(patchParam(params, "onTimeout", v))}
          >
            <SelectTrigger id="apr-ontimeout">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="reject">{t("onTimeout.reject")}</SelectItem>
              <SelectItem value="fail">{t("onTimeout.fail")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </FieldRow>
    </FieldGroup>
  )
}

export function MobileCameraConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.mobileCamera")
  const quality = readNumber(params, "quality", 70)
  const width = readNumber(params, "width", 1280)
  return (
    <FieldGroup>
      <FieldRow>
        <Field label={t("quality.label")} htmlFor="mc-quality" name="quality">
          <Input
            id="mc-quality"
            type="number"
            min={1}
            max={100}
            value={quality}
            onChange={(e) => onChange(patchParam(params, "quality", Number(e.target.value) || 70))}
          />
        </Field>
        <Field label={t("width.label")} htmlFor="mc-width" name="width">
          <Input
            id="mc-width"
            type="number"
            min={64}
            value={width}
            onChange={(e) => onChange(patchParam(params, "width", Number(e.target.value) || 1280))}
          />
        </Field>
      </FieldRow>
      <MobileRoutingFields params={params} onChange={onChange} />
    </FieldGroup>
  )
}

export function MobileScanBarcodeConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.mobileScanBarcode")
  const raw = params.formats
  const formats = Array.isArray(raw) ? (raw as string[]).join(", ") : ""
  return (
    <FieldGroup>
      <Field
        label={t("formats.label")}
        htmlFor="ms-formats"
        hint={t("formats.hint")}
        name="formats"
      >
        <Input
          id="ms-formats"
          value={formats}
          onChange={(e) =>
            onChange(
              patchParam(
                params,
                "formats",
                e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              )
            )
          }
        />
      </Field>
      <MobileRoutingFields params={params} onChange={onChange} />
    </FieldGroup>
  )
}

export function MobileLocationConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.mobileLocation")
  const high = readBoolean(params, "enableHighAccuracy", false)
  return (
    <FieldGroup>
      <Field label={t("enableHighAccuracy.label")} htmlFor="ml-high" name="enableHighAccuracy">
        <Switch
          id="ml-high"
          checked={high}
          onCheckedChange={(v) => onChange(patchParam(params, "enableHighAccuracy", v))}
        />
      </Field>
      <MobileRoutingFields params={params} onChange={onChange} />
    </FieldGroup>
  )
}

export function MobileShareConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.mobileShare")
  const title = readString(params, "title")
  const text = readString(params, "text")
  const url = readString(params, "url")
  return (
    <FieldGroup>
      <Field label={t("title.label")} htmlFor="msh-title" name="title">
        <Input
          id="msh-title"
          value={title}
          onChange={(e) => onChange(patchParam(params, "title", e.target.value))}
        />
      </Field>
      <Field label={t("text.label")} htmlFor="msh-text" hint={t("text.hint")} name="text">
        <Textarea
          id="msh-text"
          value={text}
          rows={3}
          onChange={(e) => onChange(patchParam(params, "text", e.target.value))}
        />
      </Field>
      <Field label={t("url.label")} htmlFor="msh-url" name="url">
        <Input
          id="msh-url"
          value={url}
          onChange={(e) => onChange(patchParam(params, "url", e.target.value))}
        />
      </Field>
      <MobileRoutingFields params={params} onChange={onChange} />
    </FieldGroup>
  )
}

export function MobileNotifyConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.mobileNotify")
  const title = readString(params, "title")
  const body = readString(params, "body")
  return (
    <FieldGroup>
      <Field label={t("title.label")} htmlFor="mn-title" name="title" required>
        <Input
          id="mn-title"
          value={title}
          onChange={(e) => onChange(patchParam(params, "title", e.target.value))}
        />
      </Field>
      <Field label={t("body.label")} htmlFor="mn-body" name="body">
        <Textarea
          id="mn-body"
          value={body}
          rows={3}
          onChange={(e) => onChange(patchParam(params, "body", e.target.value))}
        />
      </Field>
      <MobileRoutingFields params={params} onChange={onChange} />
    </FieldGroup>
  )
}
