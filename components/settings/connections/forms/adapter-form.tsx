"use client"

/**
 * Generic JSON-Schema (draft-07) driven settings form.
 *
 * The configuration surface for connector kinds contributed by plugins. A
 * plugin can own a `PlatformKind`, run the full supervisor path and appear in
 * the Inbox, but until now it could not be CONFIGURED: the picker's kind list
 * was eleven hardcoded literals and this generator — written for exactly this
 * job, `secretFields` and all — sat in the unreachable-components baseline.
 *
 * string → Input, boolean → Switch, enum → Select. Fields named in
 * `secretFields` (derived from the schema by `pluginConnectorSecretFields`)
 * render the shared `CredentialInput` and are bound to a `useAdapterCredentials`
 * controller, so a plugin connector gets exactly what a built-in one has:
 * values stored in the OS keyring rather than in a Dexie row, prefilled masked
 * on reopen, revealable, and honest about a value the host refused to read.
 * They are never part of the submitted `values`.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { CredentialInput } from "@/components/settings/connections/forms/_shared/credential-input"
import type { UseAdapterCredentialsResult } from "@/hooks/connectors/use-adapter-credentials"
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
  /** draft-07: may be sent but never returned. Treated as a secret. */
  writeOnly?: boolean
  /** `"password"` is the other spelling of the same intent. */
  format?: string
}

export interface JsonSchema {
  type?: string
  required?: string[]
  properties?: Record<string, JsonSchemaProperty>
}

export interface AdapterFormProps {
  schema: JsonSchema
  initialValues?: Record<string, unknown>
  /** Field names that hold secrets — rendered as `CredentialInput`. */
  secretFields?: string[]
  /**
   * Keyring-backed state for the secret fields. Needed whenever `secretFields`
   * is non-empty: the form deliberately has no local secret state, so there is
   * no path on which a secret reaches `values`. Optional only so a schema with
   * no secrets can omit it — a secret field without a controller renders
   * DISABLED rather than falling back to the plain input, which would write the
   * value into `values` and persist it into the row.
   */
  credentials?: UseAdapterCredentialsResult
  onSubmit: (values: Record<string, unknown>) => void | Promise<void>
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
  credentials,
  onSubmit,
  onCancel,
  submitLabel,
  disabled = false,
}: AdapterFormProps) {
  const t = useTranslations("settings.connections.adapterForm")
  const properties = schema.properties ?? {}
  const propEntries = Object.entries(properties)
  const resolvedSubmitLabel = submitLabel ?? t("save")

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

  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    try {
      await onSubmit(values)
    } finally {
      setSubmitting(false)
    }
  }

  const updateValue = (key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }))
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
              // A secret NEVER falls back to the plain input below: that branch
              // writes through `updateValue`, so an omitted `credentials` would
              // put the value into `values` and persist it unencrypted into
              // `AdapterInstanceRow.settings`. Without a controller there is
              // nowhere safe to keep it, so the field renders inert instead.
              <CredentialInput
                id={fieldId}
                sensitive
                value={credentials ? credentials.value(key) : ""}
                status={credentials ? credentials.status(key) : "stored"}
                onChange={(next) => credentials?.set(key, next)}
                disabled={disabled || submitting || !credentials}
                placeholder={t("enterField", { label })}
                unavailableReason={credentials ? undefined : t("secretUnavailable")}
                onRetry={credentials?.retry}
              />
            ) : (
              <Input
                id={fieldId}
                type="text"
                value={String(values[key] ?? "")}
                onChange={(e) => updateValue(key, e.target.value)}
                disabled={disabled || submitting}
                placeholder={t("enterField", { label })}
              />
            )}
          </div>
        )
      })}

      <div className="flex items-center justify-end gap-2 pt-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
            {t("cancel")}
          </Button>
        )}
        <Button type="submit" disabled={disabled || submitting}>
          {submitting ? t("saving") : resolvedSubmitLabel}
        </Button>
      </div>
    </form>
  )
}
