"use client"

/**
 * 11 thin inspector shells for the `action.desktop.*` node kinds. Each one
 * wraps {@link DesktopActionForm} with the per-kind specific fields. Replaces
 * the generic JSON Fallback that was the M2-shipped placeholder.
 *
 * Forms intentionally stay declarative — the executors in
 * `lib/workflow/nodes/desktop.ts` do the heavy lifting through the
 * automation client.
 */

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
import { Field, patchParam, readBoolean, readNumber, readString } from "../shared"
import { DesktopActionForm } from "./desktop-action-form"

type Params = Record<string, unknown>
type Props = { params: Params; onChange: (next: Params) => void }

export function DesktopScreenshotConfig({ params, onChange }: Props) {
  const t = useTranslations("workflows.forms.desktopScreenshot")
  const format = readString(params, "format") || "png"
  const fullScreen = readBoolean(params, "fullScreen", false)
  const outputPath = readString(params, "outputPath")
  return (
    <DesktopActionForm
      params={params}
      onChange={onChange}
      selectorHint={t("selector.hint")}
      extraFields={
        <>
          <Field label={t("format.label")} htmlFor="ss-format" name="format">
            <Select value={format} onValueChange={(v) => onChange(patchParam(params, "format", v))}>
              <SelectTrigger id="ss-format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="png">png</SelectItem>
                <SelectItem value="jpeg">jpeg</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("fullScreen.label")} htmlFor="ss-full" name="fullScreen">
            <Switch
              id="ss-full"
              checked={fullScreen}
              onCheckedChange={(v) => onChange(patchParam(params, "fullScreen", Boolean(v)))}
            />
          </Field>
          <Field
            label={t("outputPath.label")}
            htmlFor="ss-out"
            hint={t("outputPath.hint")}
            name="outputPath"
          >
            <Input
              id="ss-out"
              placeholder={t("outputPath.placeholder")}
              value={outputPath}
              onChange={(e) => onChange(patchParam(params, "outputPath", e.target.value))}
            />
          </Field>
        </>
      }
    />
  )
}

export function DesktopFindElementConfig({ params, onChange }: Props) {
  const t = useTranslations("workflows.forms.desktopFindElement")
  return <DesktopActionForm params={params} onChange={onChange} selectorHint={t("selector.hint")} />
}

export function DesktopReadTreeConfig({ params, onChange }: Props) {
  const t = useTranslations("workflows.forms.desktopReadTree")
  const maxDepth = readNumber(params, "maxDepth", 5)
  return (
    <DesktopActionForm
      params={params}
      onChange={onChange}
      selectorHint={t("selector.hint")}
      extraFields={
        <Field
          label={t("maxDepth.label")}
          htmlFor="rt-depth"
          hint={t("maxDepth.hint")}
          name="maxDepth"
        >
          <Input
            id="rt-depth"
            type="number"
            min={1}
            value={maxDepth}
            onChange={(e) =>
              onChange(patchParam(params, "maxDepth", Math.max(1, Number(e.target.value) || 1)))
            }
          />
        </Field>
      }
    />
  )
}

export function DesktopClickConfig({ params, onChange }: Props) {
  const t = useTranslations("workflows.forms.desktopClick")
  const button = readString(params, "button") || "left"
  const clickCount = readNumber(params, "clickCount", 1)
  return (
    <DesktopActionForm
      params={params}
      onChange={onChange}
      selectorHint={t("selector.hint")}
      extraFields={
        <div className="grid grid-cols-2 gap-2">
          <Field label={t("button.label")} htmlFor="click-btn" name="button">
            <Select value={button} onValueChange={(v) => onChange(patchParam(params, "button", v))}>
              <SelectTrigger id="click-btn">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="left">left</SelectItem>
                <SelectItem value="right">right</SelectItem>
                <SelectItem value="middle">middle</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("clickCount.label")} htmlFor="click-count" name="clickCount">
            <Input
              id="click-count"
              type="number"
              min={1}
              max={3}
              value={clickCount}
              onChange={(e) =>
                onChange(patchParam(params, "clickCount", Math.max(1, Number(e.target.value) || 1)))
              }
            />
          </Field>
        </div>
      }
    />
  )
}

export function DesktopTypeConfig({ params, onChange }: Props) {
  const t = useTranslations("workflows.forms.desktopType")
  const text = readString(params, "text")
  const delayMs = readNumber(params, "delayMs", 0)
  return (
    <DesktopActionForm
      params={params}
      onChange={onChange}
      selectorHint={t("selector.hint")}
      extraFields={
        <>
          <Field label={t("text.label")} htmlFor="type-text" name="text" required>
            <Textarea
              id="type-text"
              rows={3}
              value={text}
              onChange={(e) => onChange(patchParam(params, "text", e.target.value))}
              placeholder={t("text.placeholder")}
            />
          </Field>
          <Field
            label={t("delayMs.label")}
            htmlFor="type-delay"
            hint={t("delayMs.hint")}
            name="delayMs"
          >
            <Input
              id="type-delay"
              type="number"
              min={0}
              value={delayMs}
              onChange={(e) =>
                onChange(patchParam(params, "delayMs", Math.max(0, Number(e.target.value) || 0)))
              }
            />
          </Field>
        </>
      }
    />
  )
}

export function DesktopKeysConfig({ params, onChange }: Props) {
  const t = useTranslations("workflows.forms.desktopKeys")
  const chord = readString(params, "chord")
  return (
    <DesktopActionForm
      params={params}
      onChange={onChange}
      showSelector={false}
      extraFields={
        <Field
          label={t("chord.label")}
          htmlFor="keys-chord"
          hint={t("chord.hint")}
          name="chord"
          required
        >
          <Input
            id="keys-chord"
            placeholder={t("chord.placeholder")}
            value={chord}
            onChange={(e) => onChange(patchParam(params, "chord", e.target.value))}
          />
        </Field>
      }
    />
  )
}

const INVOKE_PATTERNS = [
  "Invoke",
  "Toggle",
  "ExpandCollapse",
  "Value",
  "SelectionItem",
  "ScrollItem",
  "RangeValue",
] as const

export function DesktopInvokePatternConfig({ params, onChange }: Props) {
  const t = useTranslations("workflows.forms.desktopInvokePattern")
  const pattern = readString(params, "pattern") || "Invoke"
  const value = readString(params, "value")
  return (
    <DesktopActionForm
      params={params}
      onChange={onChange}
      selectorHint={t("selector.hint")}
      extraFields={
        <>
          <Field label={t("pattern.label")} htmlFor="ip-pattern" name="pattern" required>
            <Select
              value={pattern}
              onValueChange={(v) => onChange(patchParam(params, "pattern", v))}
            >
              <SelectTrigger id="ip-pattern">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INVOKE_PATTERNS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("value.label")} htmlFor="ip-value" hint={t("value.hint")} name="value">
            <Input
              id="ip-value"
              value={value}
              onChange={(e) => onChange(patchParam(params, "value", e.target.value))}
            />
          </Field>
        </>
      }
    />
  )
}

export function DesktopWindowFocusConfig({ params, onChange }: Props) {
  const t = useTranslations("workflows.forms.desktopWindowFocus")
  return <DesktopActionForm params={params} onChange={onChange} selectorHint={t("selector.hint")} />
}

export function DesktopWindowCloseConfig({ params, onChange }: Props) {
  const t = useTranslations("workflows.forms.desktopWindowClose")
  return <DesktopActionForm params={params} onChange={onChange} selectorHint={t("selector.hint")} />
}

export function DesktopWindowResizeConfig({ params, onChange }: Props) {
  const t = useTranslations("workflows.forms.desktopWindowResize")
  const width = readNumber(params, "width", 1280)
  const height = readNumber(params, "height", 720)
  return (
    <DesktopActionForm
      params={params}
      onChange={onChange}
      selectorHint={t("selector.hint")}
      extraFields={
        <div className="grid grid-cols-2 gap-2">
          <Field label={t("width.label")} htmlFor="wr-w" name="width">
            <Input
              id="wr-w"
              type="number"
              min={100}
              value={width}
              onChange={(e) =>
                onChange(patchParam(params, "width", Math.max(100, Number(e.target.value) || 100)))
              }
            />
          </Field>
          <Field label={t("height.label")} htmlFor="wr-h" name="height">
            <Input
              id="wr-h"
              type="number"
              min={100}
              value={height}
              onChange={(e) =>
                onChange(patchParam(params, "height", Math.max(100, Number(e.target.value) || 100)))
              }
            />
          </Field>
        </div>
      }
    />
  )
}

export function DesktopWaitConfig({ params, onChange }: Props) {
  const t = useTranslations("workflows.forms.desktopWait")
  const eventKind = readString(params, "eventKind") || "elementVisible"
  return (
    <DesktopActionForm
      params={params}
      onChange={onChange}
      selectorHint={t("selector.hint")}
      extraFields={
        <Field
          label={t("eventKind.label")}
          htmlFor="wait-kind"
          hint={t("eventKind.hint")}
          name="eventKind"
        >
          <Select
            value={eventKind}
            onValueChange={(v) => onChange(patchParam(params, "eventKind", v))}
          >
            <SelectTrigger id="wait-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="elementVisible">
                {t("eventKind.options.elementVisible")}
              </SelectItem>
              <SelectItem value="elementHidden">{t("eventKind.options.elementHidden")}</SelectItem>
              <SelectItem value="windowReady">{t("eventKind.options.windowReady")}</SelectItem>
              <SelectItem value="propertyChanged">
                {t("eventKind.options.propertyChanged")}
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
      }
    />
  )
}
