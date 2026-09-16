/**
 * A tenant catalog entry as the "Image catalog" editor holds it (ADR-0182).
 *
 * The Host is the authority — `EffectiveCatalog::merge` refuses whatever would
 * widen the baseline, and `CatalogEntry::validate` whatever is malformed — so
 * the checks here only mirror the structural ones, to name the field before a
 * round trip. Nothing a person can type passes here and is then silently
 * accepted differently by the Host: every rule below is one of
 * `crates/cognia-environment/src/catalog.rs`'s, with its code.
 *
 * # Why the image is always resolved first
 *
 * A catalog entry is pinned to a digest (`catalog_entry_unpinned` otherwise),
 * and its `imageUser` is what the registry says the image runs as. Both come
 * from `environment_image_inspect`, never from what was typed: a tag the
 * registry later moves must not change what an entry means, and a user the
 * editor guessed would be shown on every run as a fact.
 */

import type { CatalogEntryRecord } from "@/lib/project-environment/environment-client"
import type { IsolationTier } from "@/types/sandbox/environment-spec"

import { isValidCatalogEntryId } from "./runtime-selection"

const MAX_LABEL_CHARS = 128
const MAX_DESCRIPTION_CHARS = 2000

/** An image as the registry answered for it. */
export interface ResolvedCatalogImage {
  registry: string
  repository: string
  /** `sha256:<hex>`, what the entry is pinned to. */
  digest: string
  /** The tag it was resolved from; informational once pinned. */
  tag?: string
  /**
   * The user every platform runs as. `undefined` is root; `null` means the
   * platforms disagree, which no single `imageUser` can state.
   */
  user: string | undefined | null
  /** `os/arch[/variant]` for each platform the image offers. */
  platforms: string[]
}

export interface CatalogEntryDraft {
  id: string
  label: string
  description: string
  /** Absent until the typed reference has been resolved. */
  image?: ResolvedCatalogImage
  isolationFloor: IsolationTier
  /** The first is the default. */
  sizeClassIds: string[]
}

export type CatalogDraftField = "id" | "label" | "description" | "image" | "sizeClassIds"

/**
 * What stops a draft from being written. The Host's codes where the Host has
 * one; `image_unresolved` and `image_user_ambiguous` are the editor's own,
 * since the Host never sees a draft in either state.
 */
export type CatalogDraftProblemCode =
  "catalog_entry_invalid" | "catalog_entry_unpinned" | "image_unresolved" | "image_user_ambiguous"

export interface CatalogDraftProblem {
  field: CatalogDraftField
  code: CatalogDraftProblemCode
}

/** A blank draft for a new tenant entry. */
export function emptyCatalogDraft(defaults: {
  isolationFloor: IsolationTier
  sizeClassId?: string
}): CatalogEntryDraft {
  return {
    id: "",
    label: "",
    description: "",
    isolationFloor: defaults.isolationFloor,
    sizeClassIds: defaults.sizeClassId ? [defaults.sizeClassId] : [],
  }
}

/**
 * The draft for an existing entry. Its image is already resolved: it was
 * pinned when the entry was written, and re-asking the registry is only
 * needed if the person changes the reference.
 */
export function draftFromRecord(record: CatalogEntryRecord): CatalogEntryDraft {
  const { image } = record
  return {
    id: record.id,
    label: record.label,
    description: record.description ?? "",
    ...(image.digest
      ? {
          image: {
            registry: image.registry,
            repository: image.repository,
            digest: image.digest,
            ...(image.tag === undefined ? {} : { tag: image.tag }),
            user: record.imageUser,
            platforms: [],
          },
        }
      : {}),
    isolationFloor: record.isolationFloor,
    sizeClassIds: [...record.sizeClassIds],
  }
}

/** The reference a draft's image reads as: `registry/repository[:tag]@digest`. */
export function resolvedImageReference(image: ResolvedCatalogImage): string {
  const tag = image.tag === undefined ? "" : `:${image.tag}`
  return `${image.registry}/${image.repository}${tag}@${image.digest}`
}

/** Every structural reason `draft` would be refused, in field order. */
export function validateCatalogDraft(draft: CatalogEntryDraft): CatalogDraftProblem[] {
  const problems: CatalogDraftProblem[] = []
  if (!isValidCatalogEntryId(draft.id.trim())) {
    problems.push({ field: "id", code: "catalog_entry_invalid" })
  }
  const label = draft.label.trim()
  if (label.length === 0 || [...label].length > MAX_LABEL_CHARS) {
    problems.push({ field: "label", code: "catalog_entry_invalid" })
  }
  if ([...draft.description.trim()].length > MAX_DESCRIPTION_CHARS) {
    problems.push({ field: "description", code: "catalog_entry_invalid" })
  }
  if (!draft.image) {
    problems.push({ field: "image", code: "image_unresolved" })
  } else if (!draft.image.digest) {
    problems.push({ field: "image", code: "catalog_entry_unpinned" })
  } else if (draft.image.user === null) {
    problems.push({ field: "image", code: "image_user_ambiguous" })
  }
  if (draft.sizeClassIds.length === 0) {
    problems.push({ field: "sizeClassIds", code: "catalog_entry_invalid" })
  }
  return problems
}

/**
 * The record to write for `draft`, or `undefined` while it has problems.
 *
 * An update carries forward what the editor does not own — the source (a
 * `build` entry stays one), provenance and the Host-stamped timestamps — so
 * editing a label cannot quietly turn a built image into a hand-typed one.
 * Revocation is not carried either way: the Host keeps it, and only the
 * delete command sets it.
 */
export function catalogRecordFromDraft(
  draft: CatalogEntryDraft,
  existing?: CatalogEntryRecord
): CatalogEntryRecord | undefined {
  const image = draft.image
  if (!image || validateCatalogDraft(draft).length > 0) return undefined
  const description = draft.description.trim()
  return {
    id: existing?.id ?? draft.id.trim(),
    scope: "tenant",
    label: draft.label.trim(),
    ...(description ? { description } : {}),
    image: {
      registry: image.registry,
      repository: image.repository,
      digest: image.digest,
      ...(image.tag === undefined ? {} : { tag: image.tag }),
    },
    isolationFloor: draft.isolationFloor,
    sizeClassIds: [...new Set(draft.sizeClassIds)],
    ...(typeof image.user === "string" ? { imageUser: image.user } : {}),
    source: existing?.source ?? "manual",
    ...(existing?.provenance === undefined ? {} : { provenance: existing.provenance }),
    createdAt: existing?.createdAt ?? 0,
    updatedAt: existing?.updatedAt ?? 0,
  }
}

/**
 * `sizeClassIds` with `id` made the default (moved first), added if absent.
 * The Host reads the first id as the default, so order is the whole contract.
 */
export function withDefaultSizeClass(sizeClassIds: readonly string[], id: string): string[] {
  return [id, ...sizeClassIds.filter((candidate) => candidate !== id)]
}

/** `sizeClassIds` with `id` added (after the default) or removed. */
export function toggleSizeClass(
  sizeClassIds: readonly string[],
  id: string,
  on: boolean
): string[] {
  if (!on) return sizeClassIds.filter((candidate) => candidate !== id)
  return sizeClassIds.includes(id) ? [...sizeClassIds] : [...sizeClassIds, id]
}
