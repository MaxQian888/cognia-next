"use client"

/**
 * Generic JSON Schema → form renderer used as the inspector form for
 * plugin-contributed nodes that supply a `paramsSchema`. Recognised subset:
 *
 *   • `type: "object"` with `properties` — recurses (rendered as a section
 *     when nested, top-level object becomes the form root).
 *   • `type: "string"` — `<Input>`. Honors `format`:
 *       - `"textarea"` → `<Textarea>`
 *       - `"expression"` → `<ExpressionField>` (CodeMirror with $ / {{ }})
 *       - `"password"` → `<Input type="password">`
 *       - `"url"` → `<Input type="url">`
 *     `enum: [...]` → `<Select>`.
 *   • `type: "number" | "integer"` — `<Input type="number">` with min/max/step.
 *   • `type: "boolean"` — `<Switch>`.
 *   • `type: "array"` with `items.type === "string"` — tag list with +/-.
 *   • Anything unrecognised — JSON textarea fallback so users always have
 *     a way to edit.
 *
 * Field metadata (`title`, `description`, `default`, `examples[0]`) maps to
 * label / hint / default value / placeholder. The schema's top-level
 * `required: string[]` drives the asterisk + `name` plumbing on `Field`.
 *
 * `messages` localizes that text: each field's label, hint and enum option
 * labels resolve by the field's path from the root, falling back to the
 * schema's own text. An enum field with `format: "ai-provider"` lists
 * provider display names rather than ids.
 */

import { useState, useEffect, useId, useMemo } from "react"
import { useTranslations } from "next-intl"
import { Plus, Trash2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getProviderDisplayName } from "@/lib/ai/icons"
import { Field, FieldGroup, patchParam } from "./shared"
import { ExpressionField } from "./shared/expression-field"

// ── Schema typing ──────────────────────────────────────────────────────────

export interface JsonSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array"
  title?: string
  description?: string
  default?: unknown
  examples?: unknown[]
  enum?: ReadonlyArray<string | number>
  format?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  minimum?: number
  maximum?: number
  multipleOf?: number
  minLength?: number
  maxLength?: number
}

/**
 * Localized field text. Each resolver gets the field's path of property names
 * from the form root and returns undefined to keep the schema's own text.
 */
export interface SchemaFormMessages {
  label(path: readonly string[]): string | undefined
  description(path: readonly string[]): string | undefined
  option(path: readonly string[], value: string): string | undefined
}

export interface SchemaFormProps {
  /**
   * Top-level schema. Should be `type: "object"` with `properties`. Other
   * shapes fall back to a JSON editor (so the user is never stranded).
   */
  schema: JsonSchema
  params: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  messages?: SchemaFormMessages
}

/** What a field shows, resolved once by `ObjectFields`. */
interface FieldText {
  label: string
  hint?: string
  option(value: string): string
}

const NONE_SENTINEL = "__schema_form_none__"

function isNumeric(s: JsonSchema): boolean {
  return s.type === "number" || s.type === "integer"
}

function placeholderFor(schema: JsonSchema): string | undefined {
  const ex = schema.examples?.[0]
  if (typeof ex === "string") return ex
  if (typeof ex === "number") return String(ex)
  return undefined
}

function labelFor(name: string, schema: JsonSchema): string {
  if (schema.title) return schema.title
  // Camel-case → Sentence case fallback so plugin authors can omit titles
  // and still get readable labels: "myFieldName" → "My field name".
  const words = name
    .replace(/([A-Z])/g, " $1")
    .replace(/[._-]+/g, " ")
    .trim()
    .toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// ── Field renderers ────────────────────────────────────────────────────────

function StringField({
  name,
  schema,
  text,
  value,
  onChange,
  required,
}: {
  name: string
  schema: JsonSchema
  text: FieldText
  value: unknown
  onChange: (v: unknown) => void
  required: boolean
}) {
  const id = useId()
  const t = useTranslations("workflows.forms.schemaForm")
  const str = typeof value === "string" ? value : ""
  const placeholder = placeholderFor(schema)

  if (schema.enum && schema.enum.length > 0) {
    return (
      <Field label={text.label} htmlFor={id} hint={text.hint} name={name} required={required}>
        <Select
          value={str || undefined}
          onValueChange={(v) => onChange(v === NONE_SENTINEL ? "" : v)}
        >
          <SelectTrigger id={id}>
            <SelectValue placeholder={placeholder ?? t("selectPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {!required ? <SelectItem value={NONE_SENTINEL}>—</SelectItem> : null}
            {schema.enum.map((opt) => (
              <SelectItem key={String(opt)} value={String(opt)}>
                {text.option(String(opt))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    )
  }

  if (schema.format === "expression") {
    return (
      <Field label={text.label} htmlFor={id} hint={text.hint} name={name} required={required}>
        <ExpressionField
          id={id}
          value={str}
          onChange={onChange}
          multiline
          rows={3}
          placeholder={placeholder}
        />
      </Field>
    )
  }

  if (schema.format === "textarea") {
    return (
      <Field label={text.label} htmlFor={id} hint={text.hint} name={name} required={required}>
        <Textarea
          id={id}
          value={str}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          placeholder={placeholder}
          maxLength={schema.maxLength}
        />
      </Field>
    )
  }

  const inputType =
    schema.format === "password"
      ? "password"
      : schema.format === "url"
        ? "url"
        : schema.format === "email"
          ? "email"
          : "text"

  return (
    <Field label={text.label} htmlFor={id} hint={text.hint} name={name} required={required}>
      <Input
        id={id}
        type={inputType}
        value={str}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={schema.maxLength}
        minLength={schema.minLength}
      />
    </Field>
  )
}

function NumberField({
  name,
  schema,
  text,
  value,
  onChange,
  required,
}: {
  name: string
  schema: JsonSchema
  text: FieldText
  value: unknown
  onChange: (v: unknown) => void
  required: boolean
}) {
  const id = useId()
  const num =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : typeof schema.default === "number"
        ? schema.default
        : 0
  return (
    <Field label={text.label} htmlFor={id} hint={text.hint} name={name} required={required}>
      <Input
        id={id}
        type="number"
        value={num}
        min={schema.minimum}
        max={schema.maximum}
        step={schema.multipleOf ?? (schema.type === "integer" ? 1 : undefined)}
        onChange={(e) => {
          const parsed = Number(e.target.value)
          if (Number.isNaN(parsed)) return
          onChange(schema.type === "integer" ? Math.round(parsed) : parsed)
        }}
      />
    </Field>
  )
}

function BooleanField({
  name,
  schema,
  text,
  value,
  onChange,
  required,
}: {
  name: string
  schema: JsonSchema
  text: FieldText
  value: unknown
  onChange: (v: unknown) => void
  required: boolean
}) {
  const id = useId()
  const checked = typeof value === "boolean" ? value : Boolean(schema.default)
  return (
    <Field label={text.label} htmlFor={id} hint={text.hint} name={name} required={required}>
      <Switch id={id} checked={checked} onCheckedChange={onChange} aria-label={text.label} />
    </Field>
  )
}

function StringArrayField({
  name,
  schema,
  text,
  value,
  onChange,
  required,
}: {
  name: string
  schema: JsonSchema
  text: FieldText
  value: unknown
  onChange: (v: unknown) => void
  required: boolean
}) {
  const id = useId()
  const t = useTranslations("workflows.forms.arrayField")
  const arr = useMemo<string[]>(() => (Array.isArray(value) ? (value as string[]) : []), [value])
  return (
    <Field label={text.label} htmlFor={id} hint={text.hint} name={name} required={required}>
      <div className="space-y-2">
        {arr.map((item, i) => (
          <div key={i} className="flex gap-2">
            <Input
              id={i === 0 ? id : undefined}
              value={item}
              onChange={(e) => {
                const next = [...arr]
                next[i] = e.target.value
                onChange(next)
              }}
              placeholder={schema.items?.examples?.[0] as string | undefined}
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => onChange(arr.filter((_, j) => j !== i))}
              aria-label={t("removeItem", { index: i + 1 })}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button type="button" size="sm" variant="outline" onClick={() => onChange([...arr, ""])}>
          <Plus className="size-3.5 mr-1" /> {t("add")}
        </Button>
      </div>
    </Field>
  )
}

function JsonFallbackField({
  name,
  schema,
  text,
  value,
  onChange,
  required,
}: {
  name: string
  schema: JsonSchema
  text: FieldText
  value: unknown
  onChange: (v: unknown) => void
  required: boolean
}) {
  const id = useId()
  const t = useTranslations("workflows.forms.schemaForm")
  const [json, setJson] = useState(() => JSON.stringify(value ?? schema.default ?? null, null, 2))
  // Reset on external change.
  const [prev, setPrev] = useState(value)
  if (prev !== value) {
    setPrev(value)
    setJson(JSON.stringify(value ?? schema.default ?? null, null, 2))
  }
  return (
    <Field
      label={text.label}
      htmlFor={id}
      hint={text.hint ?? t("editAsJson")}
      name={name}
      required={required}
    >
      <Textarea
        id={id}
        value={json}
        onChange={(e) => {
          const next = e.target.value
          setJson(next)
          try {
            onChange(JSON.parse(next))
          } catch {
            // Don't propagate broken JSON; user keeps editing.
          }
        }}
        rows={5}
        className="font-mono text-xs"
      />
    </Field>
  )
}

// ── Object renderer (also the top-level entry point) ──────────────────────

/** Resolve a field's label, hint and option labels: `messages` first, then the schema. */
function fieldText(
  path: readonly string[],
  schema: JsonSchema,
  messages: SchemaFormMessages | undefined
): FieldText {
  return {
    label: messages?.label(path) ?? labelFor(path[path.length - 1]!, schema),
    hint: messages?.description(path) ?? schema.description,
    option: (value) =>
      messages?.option(path, value) ??
      (schema.format === "ai-provider" ? getProviderDisplayName(value) : value),
  }
}

function ObjectFields({
  schema,
  params,
  onChange,
  messages,
  path = [],
}: {
  schema: JsonSchema
  params: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  messages?: SchemaFormMessages
  /** Property names from the form root to this object. */
  path?: readonly string[]
}) {
  // Apply defaults exactly once when a field has no value yet. Without this,
  // a plugin schema with `default: 5` would never seed `params.foo = 5`,
  // so the executor would receive `undefined` instead.
  useEffect(() => {
    if (!schema.properties) return
    let mutated = false
    let next = params
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (sub.default !== undefined && !(key in params)) {
        next = patchParam(next, key, sub.default)
        mutated = true
      }
    }
    if (mutated) onChange(next)
    // We deliberately depend only on the schema reference + initial params
    // identity; subsequent param mutations should NOT re-seed defaults.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema])

  const props = schema.properties ?? {}
  const required = new Set(schema.required ?? [])

  return (
    <FieldGroup>
      {Object.entries(props).map(([key, sub]) => {
        const childOnChange = (v: unknown) => onChange(patchParam(params, key, v))
        const value = params[key]
        const isReq = required.has(key)
        const fieldPath = [...path, key]
        const text = fieldText(fieldPath, sub, messages)

        if (sub.type === "object" && sub.properties) {
          return (
            <div key={key} className="space-y-2 rounded-md border p-3">
              <p className="text-xs font-semibold">{text.label}</p>
              {text.hint ? <p className="text-[11px] text-muted-foreground">{text.hint}</p> : null}
              <ObjectFields
                schema={sub}
                params={(value as Record<string, unknown>) ?? {}}
                onChange={(nested) => onChange(patchParam(params, key, nested))}
                messages={messages}
                path={fieldPath}
              />
            </div>
          )
        }

        if (sub.type === "string") {
          return (
            <StringField
              key={key}
              name={key}
              schema={sub}
              text={text}
              value={value}
              onChange={childOnChange}
              required={isReq}
            />
          )
        }
        if (isNumeric(sub)) {
          return (
            <NumberField
              key={key}
              name={key}
              schema={sub}
              text={text}
              value={value}
              onChange={childOnChange}
              required={isReq}
            />
          )
        }
        if (sub.type === "boolean") {
          return (
            <BooleanField
              key={key}
              name={key}
              schema={sub}
              text={text}
              value={value}
              onChange={childOnChange}
              required={isReq}
            />
          )
        }
        if (sub.type === "array" && sub.items?.type === "string") {
          return (
            <StringArrayField
              key={key}
              name={key}
              schema={sub}
              text={text}
              value={value}
              onChange={childOnChange}
              required={isReq}
            />
          )
        }
        return (
          <JsonFallbackField
            key={key}
            name={key}
            schema={sub}
            text={text}
            value={value}
            onChange={childOnChange}
            required={isReq}
          />
        )
      })}
    </FieldGroup>
  )
}

export function SchemaForm({ schema, params, onChange, messages }: SchemaFormProps) {
  // Top-level shape MUST be an object schema for the form to work. Anything
  // else falls back to a single JSON textarea.
  if (schema.type !== "object" || !schema.properties) {
    return (
      <FieldGroup>
        <JsonFallbackField
          name="_root"
          schema={schema}
          text={fieldText(["_root"], schema, undefined)}
          value={params}
          onChange={(v) => onChange((v as Record<string, unknown> | null) ?? {})}
          required={false}
        />
      </FieldGroup>
    )
  }
  return <ObjectFields schema={schema} params={params} onChange={onChange} messages={messages} />
}
