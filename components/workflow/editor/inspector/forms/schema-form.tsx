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
 */

import { useState, useEffect, useId, useMemo } from "react"
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
import { Field, FieldGroup, patchParam } from "./shared"
import { ExpressionField } from "./shared/expression-field"

// ── Schema typing ──────────────────────────────────────────────────────────

interface JsonSchema {
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

export interface SchemaFormProps {
  /**
   * Top-level schema. Should be `type: "object"` with `properties`. Other
   * shapes fall back to a JSON editor (so the user is never stranded).
   */
  schema: JsonSchema
  params: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}

const NONE_SENTINEL = "__schema_form_none__"

function isNumeric(s: JsonSchema): boolean {
  return s.type === "number" || s.type === "integer"
}

function readDefault(schema: JsonSchema, value: unknown): unknown {
  if (value !== undefined) return value
  return schema.default
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
  value,
  onChange,
  required,
}: {
  name: string
  schema: JsonSchema
  value: unknown
  onChange: (v: unknown) => void
  required: boolean
}) {
  const id = useId()
  const str = typeof value === "string" ? value : ""
  const placeholder = placeholderFor(schema)

  if (schema.enum && schema.enum.length > 0) {
    return (
      <Field
        label={labelFor(name, schema)}
        htmlFor={id}
        hint={schema.description}
        name={name}
        required={required}
      >
        <Select
          value={str || undefined}
          onValueChange={(v) => onChange(v === NONE_SENTINEL ? "" : v)}
        >
          <SelectTrigger id={id}>
            <SelectValue placeholder={placeholder ?? "(select)"} />
          </SelectTrigger>
          <SelectContent>
            {!required ? <SelectItem value={NONE_SENTINEL}>—</SelectItem> : null}
            {schema.enum.map((opt) => (
              <SelectItem key={String(opt)} value={String(opt)}>
                {String(opt)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    )
  }

  if (schema.format === "expression") {
    return (
      <Field
        label={labelFor(name, schema)}
        htmlFor={id}
        hint={schema.description}
        name={name}
        required={required}
      >
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
      <Field
        label={labelFor(name, schema)}
        htmlFor={id}
        hint={schema.description}
        name={name}
        required={required}
      >
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
    <Field
      label={labelFor(name, schema)}
      htmlFor={id}
      hint={schema.description}
      name={name}
      required={required}
    >
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
  value,
  onChange,
  required,
}: {
  name: string
  schema: JsonSchema
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
    <Field
      label={labelFor(name, schema)}
      htmlFor={id}
      hint={schema.description}
      name={name}
      required={required}
    >
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
  value,
  onChange,
  required,
}: {
  name: string
  schema: JsonSchema
  value: unknown
  onChange: (v: unknown) => void
  required: boolean
}) {
  const id = useId()
  const checked = typeof value === "boolean" ? value : Boolean(schema.default)
  return (
    <Field
      label={labelFor(name, schema)}
      htmlFor={id}
      hint={schema.description}
      name={name}
      required={required}
    >
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        aria-label={labelFor(name, schema)}
      />
    </Field>
  )
}

function StringArrayField({
  name,
  schema,
  value,
  onChange,
  required,
}: {
  name: string
  schema: JsonSchema
  value: unknown
  onChange: (v: unknown) => void
  required: boolean
}) {
  const id = useId()
  const arr = useMemo<string[]>(() => (Array.isArray(value) ? (value as string[]) : []), [value])
  return (
    <Field
      label={labelFor(name, schema)}
      htmlFor={id}
      hint={schema.description}
      name={name}
      required={required}
    >
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
              aria-label={`Remove item ${i + 1}`}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button type="button" size="sm" variant="outline" onClick={() => onChange([...arr, ""])}>
          <Plus className="size-3.5 mr-1" /> Add
        </Button>
      </div>
    </Field>
  )
}

function JsonFallbackField({
  name,
  schema,
  value,
  onChange,
  required,
}: {
  name: string
  schema: JsonSchema
  value: unknown
  onChange: (v: unknown) => void
  required: boolean
}) {
  const id = useId()
  const [text, setText] = useState(() => JSON.stringify(value ?? schema.default ?? null, null, 2))
  // Reset on external change.
  const [prev, setPrev] = useState(value)
  if (prev !== value) {
    setPrev(value)
    setText(JSON.stringify(value ?? schema.default ?? null, null, 2))
  }
  return (
    <Field
      label={labelFor(name, schema)}
      htmlFor={id}
      hint={schema.description ?? "Edit as JSON"}
      name={name}
      required={required}
    >
      <Textarea
        id={id}
        value={text}
        onChange={(e) => {
          const next = e.target.value
          setText(next)
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

function ObjectFields({
  schema,
  params,
  onChange,
}: {
  schema: JsonSchema
  params: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
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

        if (sub.type === "object" && sub.properties) {
          return (
            <div key={key} className="space-y-2 rounded-md border p-3">
              {sub.title ? (
                <p className="text-xs font-semibold">{sub.title}</p>
              ) : (
                <p className="text-xs font-semibold">{labelFor(key, sub)}</p>
              )}
              {sub.description ? (
                <p className="text-[11px] text-muted-foreground">{sub.description}</p>
              ) : null}
              <ObjectFields
                schema={sub}
                params={(value as Record<string, unknown>) ?? {}}
                onChange={(nested) => onChange(patchParam(params, key, nested))}
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
            value={value}
            onChange={childOnChange}
            required={isReq}
          />
        )
      })}
    </FieldGroup>
  )
}

export function SchemaForm({ schema, params, onChange }: SchemaFormProps) {
  // Top-level shape MUST be an object schema for the form to work. Anything
  // else falls back to a single JSON textarea.
  if (schema.type !== "object" || !schema.properties) {
    return (
      <FieldGroup>
        <JsonFallbackField
          name="_root"
          schema={schema}
          value={params}
          onChange={(v) => onChange((v as Record<string, unknown> | null) ?? {})}
          required={false}
        />
      </FieldGroup>
    )
  }
  return <ObjectFields schema={schema} params={params} onChange={onChange} />
}
