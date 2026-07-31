"use client"

/**
 * Output-schema builder (D3). Authors the JSON *object* schema a typed node
 * must satisfy — a list of {name, type, required, description} rows that
 * serialize to `{ type:"object", properties, required }`, plus a raw
 * JSON-Schema escape hatch. Reused by `action.agent.turn` / `ai.prompt`
 * (typed output) and `io.output` (D5 published-interface).
 *
 * This is the inverse of `SchemaForm` (which renders a form *from* a schema);
 * here the schema itself is the edited value.
 */

import { useState } from "react"
import { useId } from "react"
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
import { Field, patchParam } from "./shared"

export type SchemaFieldType = "string" | "number" | "integer" | "boolean" | "array" | "object"

export const SCHEMA_FIELD_TYPES: readonly SchemaFieldType[] = [
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
]

export interface SchemaFieldRow {
  name: string
  type: SchemaFieldType
  required: boolean
  description: string
}

/** Derive editable rows from a JSON object schema (non-object → empty). */
export function jsonSchemaToRows(schema: Record<string, unknown> | undefined): SchemaFieldRow[] {
  if (!schema || typeof schema !== "object" || schema.type !== "object") return []
  const props =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {}
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
  return Object.entries(props).map(([name, prop]) => {
    const rawType = typeof prop?.type === "string" ? (prop.type as string) : "string"
    const type = (SCHEMA_FIELD_TYPES as readonly string[]).includes(rawType)
      ? (rawType as SchemaFieldType)
      : "string"
    return {
      name,
      type,
      required: required.includes(name),
      description: typeof prop?.description === "string" ? prop.description : "",
    }
  })
}

/** Serialize rows back to a JSON object schema, or `undefined` when empty. */
export function rowsToJsonSchema(rows: SchemaFieldRow[]): Record<string, unknown> | undefined {
  const named = rows.filter((r) => r.name.trim().length > 0)
  if (named.length === 0) return undefined
  const properties: Record<string, Record<string, unknown>> = {}
  const required: string[] = []
  for (const row of named) {
    const name = row.name.trim()
    const prop: Record<string, unknown> = { type: row.type }
    if (row.type === "array") prop.items = { type: "string" }
    if (row.description.trim()) prop.description = row.description.trim()
    properties[name] = prop
    if (row.required) required.push(name)
  }
  const schema: Record<string, unknown> = { type: "object", properties }
  if (required.length > 0) schema.required = required
  return schema
}

export interface OutputSchemaFieldProps {
  value: Record<string, unknown> | undefined
  onChange: (next: Record<string, unknown> | undefined) => void
  /** Disambiguates element ids when several editors share a form. */
  idPrefix?: string
}

export function OutputSchemaField({ value, onChange, idPrefix = "os" }: OutputSchemaFieldProps) {
  const t = useTranslations("workflows.forms.outputSchema")
  const baseId = useId()
  const [mode, setMode] = useState<"fields" | "raw">("fields")
  const [rows, setRows] = useState<SchemaFieldRow[]>(() => jsonSchemaToRows(value))
  // Re-derive rows only on a genuine external change (not the echo of our own
  // onChange), so an in-progress empty-name row survives keystrokes.
  const [syncedFrom, setSyncedFrom] = useState(value)
  if (value !== syncedFrom) {
    setSyncedFrom(value)
    const ours = JSON.stringify(rowsToJsonSchema(rows) ?? null)
    if (ours !== JSON.stringify(value ?? null)) setRows(jsonSchemaToRows(value))
  }
  const [rawText, setRawText] = useState(() => JSON.stringify(value ?? {}, null, 2))

  const commitRows = (next: SchemaFieldRow[]) => {
    setRows(next)
    onChange(rowsToJsonSchema(next))
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-muted-foreground">{t("hint")}</p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            if (mode === "fields") setRawText(JSON.stringify(value ?? {}, null, 2))
            setMode(mode === "fields" ? "raw" : "fields")
          }}
        >
          {mode === "fields" ? t("editRaw") : t("editFields")}
        </Button>
      </div>

      {mode === "raw" ? (
        <Field label={t("rawLabel")} htmlFor={`${idPrefix}-${baseId}-raw`} name="outputSchema">
          <Textarea
            id={`${idPrefix}-${baseId}-raw`}
            value={rawText}
            rows={8}
            className="font-mono text-xs"
            onChange={(e) => {
              const next = e.target.value
              setRawText(next)
              try {
                const parsed = JSON.parse(next)
                onChange(
                  parsed && typeof parsed === "object"
                    ? (parsed as Record<string, unknown>)
                    : undefined
                )
              } catch {
                // Keep editing; don't propagate broken JSON.
              }
            }}
          />
        </Field>
      ) : (
        <div className="space-y-2">
          {rows.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{t("empty")}</p>
          ) : null}
          {rows.map((row, i) => (
            <div key={i} className="flex items-end gap-2 rounded-md border p-2">
              <div className="flex-1 space-y-1">
                <Input
                  aria-label={t("fieldName")}
                  placeholder={t("fieldNamePlaceholder")}
                  value={row.name}
                  onChange={(e) =>
                    commitRows(rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))
                  }
                />
                <Input
                  aria-label={t("fieldDescription")}
                  placeholder={t("fieldDescriptionPlaceholder")}
                  value={row.description}
                  onChange={(e) =>
                    commitRows(
                      rows.map((r, j) => (j === i ? { ...r, description: e.target.value } : r))
                    )
                  }
                />
              </div>
              <Select
                value={row.type}
                onValueChange={(v) =>
                  commitRows(
                    rows.map((r, j) => (j === i ? { ...r, type: v as SchemaFieldType } : r))
                  )
                }
              >
                <SelectTrigger className="w-28" aria-label={t("fieldType")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCHEMA_FIELD_TYPES.map((tp) => (
                    <SelectItem key={tp} value={tp}>
                      {tp}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex flex-col items-center gap-1">
                <span className="text-[10px] text-muted-foreground">{t("required")}</span>
                <Switch
                  aria-label={t("required")}
                  checked={row.required}
                  onCheckedChange={(v) =>
                    commitRows(rows.map((r, j) => (j === i ? { ...r, required: v } : r)))
                  }
                />
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={t("removeField")}
                onClick={() => commitRows(rows.filter((_, j) => j !== i))}
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
              commitRows([...rows, { name: "", type: "string", required: true, description: "" }])
            }
          >
            <Plus className="size-3.5 mr-1" /> {t("addField")}
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * Drop-in typed-output section for a node config form: the schema builder plus
 * the `onSchemaViolation` mode select (shown only once a schema exists). Shared
 * by `action.agent.turn` and `ai.prompt`.
 */
export function TypedOutputFields({
  params,
  onChange,
  idPrefix,
}: {
  params: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  idPrefix: string
}) {
  const t = useTranslations("workflows.forms.outputSchema")
  const value =
    params.outputSchema && typeof params.outputSchema === "object"
      ? (params.outputSchema as Record<string, unknown>)
      : undefined
  const hasSchema = !!value && Object.keys(value).length > 0
  const mode = params.onSchemaViolation === "soft" ? "soft" : "fail"
  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-xs font-semibold">{t("sectionTitle")}</p>
      <OutputSchemaField
        value={value}
        onChange={(next) => onChange(patchParam(params, "outputSchema", next))}
        idPrefix={idPrefix}
      />
      {hasSchema ? (
        <Field
          label={t("onSchemaViolation.label")}
          htmlFor={`${idPrefix}-osv`}
          hint={t("onSchemaViolation.hint")}
          name="onSchemaViolation"
        >
          <Select
            value={mode}
            onValueChange={(v) => onChange(patchParam(params, "onSchemaViolation", v))}
          >
            <SelectTrigger id={`${idPrefix}-osv`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fail">{t("onSchemaViolation.fail")}</SelectItem>
              <SelectItem value="soft">{t("onSchemaViolation.soft")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      ) : null}
    </div>
  )
}
