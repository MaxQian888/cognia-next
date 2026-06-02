/** Shared helpers for foreign eval-format adapters. */

import type { EvalCase, EvalReference } from "@/types/eval/eval"
import type { MappingDeps } from "../field-mapping"

export function asArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>
    for (const key of ["tests", "rows", "data", "examples", "samples"]) {
      if (Array.isArray(obj[key])) return obj[key]
    }
    return [obj]
  }
  return []
}

export function str(v: unknown): string {
  if (v === undefined || v === null) return ""
  return typeof v === "string" ? v : JSON.stringify(v)
}

export function buildCase(
  deps: MappingDeps,
  parts: {
    id?: string
    input: string
    reference?: EvalReference
    inputVars?: Record<string, unknown>
    metadata?: Record<string, unknown>
  }
): EvalCase {
  const ts = deps.now()
  return {
    id: parts.id || deps.id(),
    datasetId: deps.datasetId,
    input: parts.input,
    capability: deps.capability,
    source: "handwritten",
    createdAt: ts,
    updatedAt: ts,
    ...(parts.reference ? { reference: parts.reference } : {}),
    ...(parts.inputVars ? { inputVars: parts.inputVars } : {}),
    ...(parts.metadata ? { metadata: parts.metadata } : {}),
  }
}
