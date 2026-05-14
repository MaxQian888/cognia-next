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
  const format = readString(params, "format") || "png"
  const fullScreen = readBoolean(params, "fullScreen", false)
  const outputPath = readString(params, "outputPath")
  return (
    <DesktopActionForm
      params={params}
      onChange={onChange}
      selectorHint="Optional. When set, the screenshot is cropped to the element bounds; otherwise the whole window (or whole screen with `fullScreen`) is captured."
      extraFields={
        <>
          <Field label="Format" htmlFor="ss-format" name="format">
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
          <Field label="Full screen" htmlFor="ss-full" name="fullScreen">
            <Switch
              id="ss-full"
              checked={fullScreen}
              onCheckedChange={(v) => onChange(patchParam(params, "fullScreen", Boolean(v)))}
            />
          </Field>
          <Field
            label="Output path"
            htmlFor="ss-out"
            hint="Optional. When set, the screenshot is also written to disk at this path."
            name="outputPath"
          >
            <Input
              id="ss-out"
              placeholder="C:/temp/cap.png"
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
  return (
    <DesktopActionForm
      params={params}
      onChange={onChange}
      selectorHint="UIA selector. Required — the node returns the element's bounds + handle for downstream nodes."
    />
  )
}

export function DesktopReadTreeConfig({ params, onChange }: Props) {
  const maxDepth = readNumber(params, "maxDepth", 5)
  return (
    <DesktopActionForm
      params={params}
      onChange={onChange}
      selectorHint="Optional. When set, the tree is rooted at the matched element; otherwise it starts at the foreground window."
      extraFields={
        <Field
          label="Max depth"
          htmlFor="rt-depth"
          hint="How many levels to traverse. Larger values are slow; the default keeps response under a second on a typical desktop."
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
  const button = readString(params, "button") || "left"
  const clickCount = readNumber(params, "clickCount", 1)
  return (
    <DesktopActionForm
      params={params}
      onChange={onChange}
      selectorHint="UIA selector for the target. Required."
      extraFields={
        <div className="grid grid-cols-2 gap-2">
          <Field label="Button" htmlFor="click-btn" name="button">
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
          <Field label="Click count" htmlFor="click-count" name="clickCount">
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
  const text = readString(params, "text")
  const delayMs = readNumber(params, "delayMs", 0)
  return (
    <DesktopActionForm
      params={params}
      onChange={onChange}
      selectorHint="UIA selector for the target input. Optional — defaults to the focused element."
      extraFields={
        <>
          <Field label="Text" htmlFor="type-text" name="text" required>
            <Textarea
              id="type-text"
              rows={3}
              value={text}
              onChange={(e) => onChange(patchParam(params, "text", e.target.value))}
              placeholder="Hello, world!"
            />
          </Field>
          <Field
            label="Per-key delay (ms)"
            htmlFor="type-delay"
            hint="Small delay between keys, useful for apps that miss keystrokes when typed too quickly."
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
  const chord = readString(params, "chord")
  return (
    <DesktopActionForm
      params={params}
      onChange={onChange}
      showSelector={false}
      extraFields={
        <Field
          label="Key chord"
          htmlFor="keys-chord"
          hint='Use "+" between modifiers, e.g. `ctrl+shift+t`. The chord is dispatched against the focused window.'
          name="chord"
          required
        >
          <Input
            id="keys-chord"
            placeholder="ctrl+shift+p"
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
  const pattern = readString(params, "pattern") || "Invoke"
  const value = readString(params, "value")
  return (
    <DesktopActionForm
      params={params}
      onChange={onChange}
      selectorHint="UIA selector for the element supporting the chosen pattern."
      extraFields={
        <>
          <Field label="Pattern" htmlFor="ip-pattern" name="pattern" required>
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
          <Field
            label="Value"
            htmlFor="ip-value"
            hint="Required for `Value`, `RangeValue`; optional for the rest."
            name="value"
          >
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
  return (
    <DesktopActionForm
      params={params}
      onChange={onChange}
      selectorHint="UIA window selector (e.g. `name~='Notepad'`). When omitted, the foreground window is used."
    />
  )
}

export function DesktopWindowCloseConfig({ params, onChange }: Props) {
  return (
    <DesktopActionForm
      params={params}
      onChange={onChange}
      selectorHint="UIA window selector. When omitted, the foreground window is closed."
    />
  )
}

export function DesktopWindowResizeConfig({ params, onChange }: Props) {
  const width = readNumber(params, "width", 1280)
  const height = readNumber(params, "height", 720)
  return (
    <DesktopActionForm
      params={params}
      onChange={onChange}
      selectorHint="UIA window selector. Falls back to the foreground window."
      extraFields={
        <div className="grid grid-cols-2 gap-2">
          <Field label="Width (px)" htmlFor="wr-w" name="width">
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
          <Field label="Height (px)" htmlFor="wr-h" name="height">
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
  const eventKind = readString(params, "eventKind") || "elementVisible"
  return (
    <DesktopActionForm
      params={params}
      onChange={onChange}
      selectorHint="UIA selector for the element / pattern to wait on."
      extraFields={
        <Field
          label="Event"
          htmlFor="wait-kind"
          hint="What state change ends the wait."
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
              <SelectItem value="elementVisible">element visible</SelectItem>
              <SelectItem value="elementHidden">element hidden</SelectItem>
              <SelectItem value="windowReady">window ready</SelectItem>
              <SelectItem value="propertyChanged">property changed</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      }
    />
  )
}
