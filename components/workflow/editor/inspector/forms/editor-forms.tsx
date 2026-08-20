"use client"

/**
 * Per-kind inspector config forms for the Pro IDE editor nodes
 * (`action.editor.{open,reveal,showDiff,readActive,applyEdit,saveAll}`,
 * ADR-0088 Phase 3).
 *
 * Pattern mirrors `./git-ocr-forms.tsx`: every form takes `params` + `onChange`
 * and uses the shared `Field`/`FieldGroup`/`patchParam` helpers, with
 * `ExpressionField` for anything that accepts `{{ }}`. The param shapes match
 * `lib/workflow/nodes/params-schemas.ts` and the executors in
 * `lib/workflow/nodes/editor/index.ts`.
 */

import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Field, FieldGroup, patchParam, readBoolean, readString } from "./shared"
import { ExpressionField } from "./shared/expression-field"

type Params = Record<string, unknown>

interface ConfigProps {
  params: Params
  onChange: (next: Params) => void
}

/** Read an optional 1-based integer param as an editable string. */
function readInt(params: Params, key: string): string {
  const v = params[key]
  return typeof v === "number" && Number.isFinite(v) ? String(v) : ""
}

/**
 * Write a 1-based integer param, clearing it when the field is emptied.
 *
 * Stored as `undefined` rather than `0` for a blank: the schema treats absence
 * as "wherever the file already is", while a zero would be rejected as below
 * the 1-based minimum.
 */
function patchInt(params: Params, key: string, raw: string): Params {
  const trimmed = raw.trim()
  if (!trimmed) return patchParam(params, key, undefined)
  const parsed = Number.parseInt(trimmed, 10)
  return patchParam(params, key, Number.isNaN(parsed) ? undefined : parsed)
}

// ── Reusable: the two params every editor node shares ────────────────────────

/** Optional target root — defaults to the bound Pro IDE at run time. */
function RootField({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.editor.root")
  return (
    <Field label={t("label")} htmlFor="editor-root" hint={t("hint")} name="root">
      <ExpressionField
        id="editor-root"
        value={readString(params, "root")}
        onChange={(v) => onChange(patchParam(params, "root", v))}
        placeholder={t("placeholder")}
      />
    </Field>
  )
}

/** Opt-in to bringing code-server up when it is not already running. */
function AutoStartField({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.editor.autoStart")
  return (
    <Field label={t("label")} hint={t("hint")} name="autoStart">
      <Switch
        checked={readBoolean(params, "autoStart", false)}
        onCheckedChange={(b) => onChange(patchParam(params, "autoStart", b))}
      />
    </Field>
  )
}

/** Required file path — absolute, or relative to the resolved root. */
function PathField({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.editor.path")
  return (
    <Field label={t("label")} hint={t("hint")} name="path" required>
      <ExpressionField
        value={readString(params, "path")}
        onChange={(v) => onChange(patchParam(params, "path", v))}
        placeholder={t("placeholder")}
      />
    </Field>
  )
}

/** Optional 1-based cursor target, shared by open and applyEdit. */
function PositionFields({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.editor.position")
  return (
    <>
      <Field label={t("line.label")} htmlFor="editor-line" hint={t("line.hint")} name="line">
        <Input
          id="editor-line"
          inputMode="numeric"
          value={readInt(params, "line")}
          onChange={(e) => onChange(patchInt(params, "line", e.target.value))}
          placeholder={t("line.placeholder")}
        />
      </Field>
      <Field label={t("column.label")} htmlFor="editor-column" name="column">
        <Input
          id="editor-column"
          inputMode="numeric"
          value={readInt(params, "column")}
          onChange={(e) => onChange(patchInt(params, "column", e.target.value))}
          placeholder={t("column.placeholder")}
        />
      </Field>
    </>
  )
}

// ── action.editor.open ───────────────────────────────────────────────────────

export function EditorOpenConfig({ params, onChange }: ConfigProps) {
  return (
    <FieldGroup>
      <RootField params={params} onChange={onChange} />
      <PathField params={params} onChange={onChange} />
      <PositionFields params={params} onChange={onChange} />
      <AutoStartField params={params} onChange={onChange} />
    </FieldGroup>
  )
}

// ── action.editor.reveal ─────────────────────────────────────────────────────

export function EditorRevealConfig({ params, onChange }: ConfigProps) {
  return (
    <FieldGroup>
      <RootField params={params} onChange={onChange} />
      <PathField params={params} onChange={onChange} />
      <AutoStartField params={params} onChange={onChange} />
    </FieldGroup>
  )
}

// ── action.editor.showDiff ───────────────────────────────────────────────────

export function EditorShowDiffConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.editor.showDiff")
  return (
    <FieldGroup>
      <RootField params={params} onChange={onChange} />
      <PathField params={params} onChange={onChange} />
      <Field label={t("content.label")} hint={t("content.hint")} name="content" required>
        <Textarea
          value={readString(params, "content")}
          onChange={(e) => onChange(patchParam(params, "content", e.target.value))}
          placeholder={t("content.placeholder")}
          rows={6}
        />
      </Field>
      <Field
        label={t("title.label")}
        htmlFor="editor-diff-title"
        hint={t("title.hint")}
        name="title"
      >
        <ExpressionField
          id="editor-diff-title"
          value={readString(params, "title")}
          onChange={(v) => onChange(patchParam(params, "title", v))}
          placeholder={t("title.placeholder")}
        />
      </Field>
      <AutoStartField params={params} onChange={onChange} />
    </FieldGroup>
  )
}

// ── action.editor.readActive ─────────────────────────────────────────────────

export function EditorReadActiveConfig({ params, onChange }: ConfigProps) {
  return (
    <FieldGroup>
      <RootField params={params} onChange={onChange} />
      <AutoStartField params={params} onChange={onChange} />
    </FieldGroup>
  )
}

// ── action.editor.applyEdit ──────────────────────────────────────────────────

export function EditorApplyEditConfig({ params, onChange }: ConfigProps) {
  return (
    <FieldGroup>
      <RootField params={params} onChange={onChange} />
      <PathField params={params} onChange={onChange} />
      <PositionFields params={params} onChange={onChange} />
      <AutoStartField params={params} onChange={onChange} />
    </FieldGroup>
  )
}

// ── action.editor.saveAll ────────────────────────────────────────────────────

export function EditorSaveAllConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.editor.saveAll")
  return (
    <FieldGroup>
      <RootField params={params} onChange={onChange} />
      <Field label={t("path.label")} hint={t("path.hint")} name="path">
        <ExpressionField
          value={readString(params, "path")}
          onChange={(v) => onChange(patchParam(params, "path", v))}
          placeholder={t("path.placeholder")}
        />
      </Field>
      <AutoStartField params={params} onChange={onChange} />
    </FieldGroup>
  )
}
