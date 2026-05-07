"use client"

import type { ReactNode } from "react"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

/**
 * Shared form atoms used by every config component. They're intentionally
 * thin wrappers so we get consistent spacing without each form repeating
 * `<div className="space-y-1.5">`.
 */
export function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: string
  htmlFor?: string
  hint?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor} className="text-xs">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
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
