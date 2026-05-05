"use client"

// Generic JSON Schema (draft-07) driven form.
// Renders fields based on the schema's `properties` object.
// Supported field types: string → Input, boolean → Switch, enum → Select.
// Fields whose names appear in `secretFields` are rendered as
// type="password" inputs and are NOT included in the returned `values`
// object — the parent is responsible for calling connectorsKeyringSet.

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

// Minimal subset of JSON Schema (draft-07) that we handle.
export interface JsonSchemaProperty {
  type?: string | string[]
  title?: string
  description?: string
  enum?: string[]
  default?: unknown
}

export interface JsonSchema {
  type?: string
  required?: string[]
  properties?: Record<string, JsonSchemaProperty>
}

export interface AdapterFormProps {
  schema: JsonSchema
  initialValues?: Record<string, unknown>
  /** Field names that hold secrets — rendered as password inputs. */
  secretFields?: string[]
  onSubmit: (
    values: Record<string, unknown>,
    secrets: Record<string, string>
  ) => void | Promise<void>
  onCancel?: () => void
  submitLabel?: string
  disabled?: boolean
}

function resolveType(prop: JsonSchemaProperty): "string" | "boolean" | "enum" {
  if (prop.enum && prop.enum.length > 0) return "enum"
  const t = Array.isArray(prop.type) ? prop.type[0] : prop.type
  if (t === "boolean") return "boolean"
  return "string"
}

export function AdapterForm({
  schema,
  initialValues = {},
  secretFields = [],
  onSubmit,
  onCancel,
  submitLabel = "Save",
  disabled = false,
}: AdapterFormProps) {
  const properties = schema.properties ?? {}
  const propEntries = Object.entries(properties)

  // Regular field state (non-secrets)
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {}
    for (const [key, prop] of propEntries) {
      if (secretFields.includes(key)) continue
      init[key] =
        initialValues[key] ?? prop.default ?? (resolveType(prop) === "boolean" ? false : "")
    }
    return init
  })

  // Secret field state (separate; not mixed into values)
  const [secrets, setSecrets] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    for (const key of secretFields) {
      init[key] = ""
    }
    return init
  })

  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    try {
      await onSubmit(values, secrets)
    } finally {
      setSubmitting(false)
    }
  }

  const updateValue = (key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  const updateSecret = (key: string, value: string) => {
    setSecrets((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {propEntries.map(([key, prop]) => {
        const isSecret = secretFields.includes(key)
        const label = prop.title ?? key
        const type = resolveType(prop)
        const fieldId = `adapter-form-${key}`

        if (type === "boolean") {
          return (
            <div key={key} className="flex items-center justify-between gap-3">
              <Label htmlFor={fieldId} className="flex-1">
                {label}
                {prop.description && (
                  <span className="block text-xs font-normal text-muted-foreground mt-0.5">
                    {prop.description}
                  </span>
                )}
              </Label>
              <Switch
                id={fieldId}
                checked={Boolean(values[key])}
                onCheckedChange={(checked) => updateValue(key, checked)}
                disabled={disabled || submitting}
              />
            </div>
          )
        }

        if (type === "enum") {
          return (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={fieldId}>
                {label}
                {schema.required?.includes(key) && <span className="ml-1 text-destructive">*</span>}
              </Label>
              {prop.description && (
                <p className="text-xs text-muted-foreground">{prop.description}</p>
              )}
              <Select
                value={String(values[key] ?? prop.enum?.[0] ?? "")}
                onValueChange={(v) => updateValue(key, v)}
                disabled={disabled || submitting}
              >
                <SelectTrigger id={fieldId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(prop.enum ?? []).map((opt) => (
                    <SelectItem key={opt} value={opt}>
                      {opt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )
        }

        // Default: string / password input
        return (
          <div key={key} className="space-y-1.5">
            <Label htmlFor={fieldId}>
              {label}
              {schema.required?.includes(key) && <span className="ml-1 text-destructive">*</span>}
            </Label>
            {prop.description && (
              <p className="text-xs text-muted-foreground">{prop.description}</p>
            )}
            {isSecret ? (
              <Input
                id={fieldId}
                type="password"
                autoComplete="new-password"
                value={secrets[key] ?? ""}
                onChange={(e) => updateSecret(key, e.target.value)}
                disabled={disabled || submitting}
                placeholder={`Enter ${label}`}
              />
            ) : (
              <Input
                id={fieldId}
                type="text"
                value={String(values[key] ?? "")}
                onChange={(e) => updateValue(key, e.target.value)}
                disabled={disabled || submitting}
                placeholder={`Enter ${label}`}
              />
            )}
          </div>
        )
      })}

      <div className="flex items-center justify-end gap-2 pt-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={disabled || submitting}>
          {submitting ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  )
}
