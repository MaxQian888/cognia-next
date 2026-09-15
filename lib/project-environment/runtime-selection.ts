/**
 * Structural checks for a project's runtime selection (ADR-0182).
 *
 * The identifier grammars mirror `crates/cognia-environment/src/spec.rs`
 * (`is_valid_catalog_id`, `is_valid_slug`) so a selection that saves here can
 * become a spec admission does not refuse for its shape. Whether the ids name
 * something the deployment offers is the resolver's question, not this one's:
 * a catalog changes after a selection is saved.
 */

import {
  ENVIRONMENT_SPEC_LIMITS,
  ISOLATION_TIERS,
  type SandboxLifecycleKind,
} from "@/types/sandbox/environment-spec"
import type { ProjectRuntimeSelection } from "@/types/project-environment"

import { isValidImageDigest } from "./image-reference"

export const SANDBOX_LIFECYCLE_KINDS = [
  "persistent",
  "ephemeral",
] as const satisfies readonly SandboxLifecycleKind[]

/** `[a-z0-9][a-z0-9._-]{0,63}` — `spec.rs::is_valid_catalog_id`. */
export function isValidCatalogEntryId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)
}

/** `[a-z0-9][a-z0-9-]{0,62}` — `spec.rs::is_valid_slug` (size classes, presets). */
export function isValidEnvironmentSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(value)
}

export interface RuntimeSelectionProblem {
  /** Dotted path under `runtime`. */
  field: string
  reason: string
}

/** Every structural problem in a stored selection, empty when it is well formed. */
export function runtimeSelectionProblems(selection: unknown): RuntimeSelectionProblem[] {
  const problems: RuntimeSelectionProblem[] = []
  const add = (field: string, reason: string) => problems.push({ field, reason })

  if (!isRecord(selection)) {
    add("runtime", "must be an object")
    return problems
  }
  const known = new Set<string>([
    "source",
    "sizeClassId",
    "lifecycle",
    "isolationMinimum",
    "bundlePin",
    "egressPresetIds",
    "browserSidecar",
    "localContainer",
    "updatedAt",
  ])
  for (const key of Object.keys(selection)) {
    if (!known.has(key)) add(key, "is not a runtime selection field")
  }

  const source = selection.source
  if (!isRecord(source)) {
    add("source", "must be an object")
  } else if (source.kind === "auto") {
    if (Object.keys(source).length !== 1) add("source", "auto takes no other fields")
  } else if (source.kind === "catalog") {
    if (typeof source.catalogEntryId !== "string" || !isValidCatalogEntryId(source.catalogEntryId))
      add("source.catalogEntryId", "must be a catalog entry id")
    if (Object.keys(source).some((key) => key !== "kind" && key !== "catalogEntryId"))
      add("source", "catalog takes only catalogEntryId")
  } else {
    add("source.kind", "must be auto or catalog")
  }

  if (
    selection.sizeClassId !== undefined &&
    (typeof selection.sizeClassId !== "string" || !isValidEnvironmentSlug(selection.sizeClassId))
  )
    add("sizeClassId", "must be a size class id")

  if (
    selection.lifecycle !== undefined &&
    !(SANDBOX_LIFECYCLE_KINDS as readonly unknown[]).includes(selection.lifecycle)
  )
    add("lifecycle", "must be persistent or ephemeral")

  if (
    selection.isolationMinimum !== undefined &&
    !(ISOLATION_TIERS as readonly unknown[]).includes(selection.isolationMinimum)
  )
    add("isolationMinimum", "must be an isolation tier")

  if (selection.bundlePin !== undefined) {
    const pin = selection.bundlePin
    if (!isRecord(pin)) {
      add("bundlePin", "must be an object")
    } else {
      if (typeof pin.digest !== "string" || !isValidImageDigest(pin.digest))
        add("bundlePin.digest", "must be a sha256 digest")
      if (
        typeof pin.releaseTag !== "string" ||
        !pin.releaseTag.trim() ||
        pin.releaseTag.length > 128
      )
        add("bundlePin.releaseTag", "must be 1-128 characters")
      if (Object.keys(pin).some((key) => key !== "digest" && key !== "releaseTag"))
        add("bundlePin", "takes only digest and releaseTag")
    }
  }

  if (selection.egressPresetIds !== undefined) {
    const ids = selection.egressPresetIds
    if (!Array.isArray(ids)) {
      add("egressPresetIds", "must be an array")
    } else {
      if (ids.length > ENVIRONMENT_SPEC_LIMITS.maxEgressPresets)
        add("egressPresetIds", `at most ${ENVIRONMENT_SPEC_LIMITS.maxEgressPresets} presets`)
      const seen = new Set<string>()
      ids.forEach((id, index) => {
        if (typeof id !== "string" || !isValidEnvironmentSlug(id)) {
          add(`egressPresetIds[${index}]`, "must be a preset id")
        } else if (seen.has(id)) {
          add(`egressPresetIds[${index}]`, "is a duplicate")
        } else {
          seen.add(id)
        }
      })
    }
  }

  for (const flag of ["browserSidecar", "localContainer"] as const) {
    if (selection[flag] !== undefined && typeof selection[flag] !== "boolean")
      add(flag, "must be a boolean")
  }

  if (typeof selection.updatedAt !== "number" || !Number.isFinite(selection.updatedAt))
    add("updatedAt", "must be a timestamp")

  return problems
}

/** Throws with every problem listed; the storage boundary's guard. */
export function assertRuntimeSelection(
  selection: unknown
): asserts selection is ProjectRuntimeSelection {
  const problems = runtimeSelectionProblems(selection)
  if (problems.length > 0) {
    throw new Error(
      `Project runtime selection is invalid: ${problems
        .map((problem) =>
          problem.field === "runtime"
            ? `runtime ${problem.reason}`
            : `runtime.${problem.field} ${problem.reason}`
        )
        .join("; ")}`
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
