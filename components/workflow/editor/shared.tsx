"use client"

import { createContext, useContext, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import type { FieldError } from "@/lib/workflow/nodes/validate-params"

/**
 * Per-form error context — set by `InspectorPanel` once it has revalidated
 * the selected node. Forms reach into it via `useFieldError(fieldName)` so
 * they don't have to thread an `errors` prop through every <Field> usage.
 */
const FieldErrorContext = createContext<Record<string, FieldError> | null>(null)

export function FieldErrorProvider({
  errors,
  children,
}: {
  errors: Record<string, FieldError> | null
  children: ReactNode
}) {
  return <FieldErrorContext.Provider value={errors}>{children}</FieldErrorContext.Provider>
}

export function useFieldError(fieldName: string): FieldError | undefined {
  const ctx = useContext(FieldErrorContext)
  return ctx?.[fieldName]
}

/**
 * Translate a `FieldError` to a human-readable string using the shared
 * `workflows.validation.*` namespace. Falls back to the raw key when the
 * translation is missing so the user still sees something actionable.
 */
export function useTranslatedError(error: FieldError | undefined): string | undefined {
  const t = useTranslations("workflows.validation")
  if (!error) return undefined
  try {
    return t(error.key, error.params as Record<string, string | number> | undefined)
  } catch {
    return error.key
  }
}

/**
 * Shared form-row primitive. Supports:
 * - `required` — appends a red asterisk after the label
 * - `name` — when set, the field auto-pulls its error from FieldErrorProvider
 *   and renders the translated message in red below the children.
 * - `error` — overrides any context-provided error for ad-hoc cases.
 */
export function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
  required = false,
  name,
  error: explicitError,
}: {
  label: string
  htmlFor?: string
  hint?: string
  children: ReactNode
  className?: string
  required?: boolean
  /** Top-level field name in `params`. Used to look up errors from context. */
  name?: string
  /** Override the context-provided error for this field. */
  error?: FieldError
}) {
  const ctxError = useFieldError(name ?? "")
  const error = explicitError ?? (name ? ctxError : undefined)
  const errorText = useTranslatedError(error)
  return (
    <div
      className={cn("space-y-1.5", className)}
      data-field={name}
      data-invalid={errorText ? "true" : undefined}
    >
      <Label htmlFor={htmlFor} className="text-xs flex items-center gap-1">
        <span>{label}</span>
        {required ? (
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        ) : null}
      </Label>
      {children}
      {errorText ? (
        <p
          className="text-[11px] text-destructive"
          role="alert"
          data-testid={name ? `field-error-${name}` : undefined}
        >
          {errorText}
        </p>
      ) : hint ? (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}

export function FieldGroup({ children }: { children: ReactNode }) {
  return <div className="space-y-3">{children}</div>
}

/**
 * Read a string-typed param with a fallback. Used by every form to coerce
 * the loosely-typed `Record<string, unknown>` params into form values.
 */
export function readString(params: Record<string, unknown>, key: string, fallback = ""): string {
  const v = params[key]
  return typeof v === "string" ? v : fallback
}

export function readNumber(params: Record<string, unknown>, key: string, fallback = 0): number {
  const v = params[key]
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v)
  return fallback
}

export function readBoolean(
  params: Record<string, unknown>,
  key: string,
  fallback = false
): boolean {
  const v = params[key]
  return typeof v === "boolean" ? v : fallback
}

/**
 * Patch a single key in a params object and call onChange. Memo-friendly:
 * always returns a new object reference.
 */
export function patchParam<T extends Record<string, unknown>>(
  params: T,
  key: string,
  value: unknown
): T {
  return { ...params, [key]: value }
}
