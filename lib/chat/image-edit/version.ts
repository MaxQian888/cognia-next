/**
 * How an edited image finds its way back to the one it came from.
 *
 * Saving an edit is non-destructive: the original part is never touched, and
 * the result is appended to the same message as another `file` part. That only
 * works if the new part remembers where it came from, which is what the
 * `cogniaImageEdit` field on the part carries.
 *
 * The field is deliberately additive and ignorable. A client that predates it
 * sees an ordinary image file part and renders it as one, which is the correct
 * degradation: an extra thumbnail at the end of the message, not a broken one.
 * That is also why this needs no Dexie migration.
 *
 * ## Why the lineage id is the original's url
 *
 * The obvious design gives every lineage a minted id and stores it on the
 * original too. That would mean rewriting the original part on first edit,
 * which is exactly the destructive write this design exists to avoid, and it
 * would leave every image saved before this feature outside any lineage.
 *
 * Using the original's url instead makes version 0 implicit: an image with no
 * `cogniaImageEdit` simply IS the origin of the lineage keyed by its own url.
 * Nothing has to be backfilled, and because chat images are content-addressed
 * (`cognia-media:<hash>`), the key is stable across devices and across a sync.
 */

/** Bump only for a shape change readers cannot infer. */
export const IMAGE_EDIT_SCHEMA_VERSION = 1

/**
 * What was done, coarsely.
 *
 * Coarse on purpose. This is shown in the version rail and stored forever, so
 * it records the KIND of edit rather than its parameters. The prompt text in
 * particular is never persisted: it is user input that went to a model, and
 * keeping a copy in the transcript would put it into every backup and every
 * sync leg for no product reason.
 */
export type ImageEditOperation =
  | "crop"
  | "resize"
  | "rotate"
  | "flip"
  | "adjust"
  | "ai.prompt"
  | "ai.region"
  | "ai.remove-background"

export const IMAGE_EDIT_OPERATIONS: readonly ImageEditOperation[] = [
  "crop",
  "resize",
  "rotate",
  "flip",
  "adjust",
  "ai.prompt",
  "ai.region",
  "ai.remove-background",
] as const

/** Operations performed by a model rather than locally. */
export const AI_IMAGE_EDIT_OPERATIONS: readonly ImageEditOperation[] = [
  "ai.prompt",
  "ai.region",
  "ai.remove-background",
] as const

export interface ImageEditVersionV1 {
  schemaVersion: typeof IMAGE_EDIT_SCHEMA_VERSION
  /** The originating part's url. See the module note. */
  lineageId: string
  /** Unique per saved version. Doubles as the append idempotency key. */
  versionId: string
  /** `null` means the parent is the original, which carries no version. */
  parentVersionId: string | null
  operations: ImageEditOperation[]
  editedAt: number
  /** Only set for AI operations, so the rail can say which model produced it. */
  providerId?: string
  modelId?: string
}

/** The field name carried on the message part. */
export const IMAGE_EDIT_PART_KEY = "cogniaImageEdit"

interface FileLikePart {
  type?: unknown
  url?: unknown
  mediaType?: unknown
  [IMAGE_EDIT_PART_KEY]?: unknown
}

/** Whether a message part is an image file part the workbench can open. */
export function isImagePart(part: unknown): boolean {
  const file = part as FileLikePart
  return (
    file?.type === "file" &&
    typeof file.url === "string" &&
    typeof file.mediaType === "string" &&
    file.mediaType.startsWith("image/")
  )
}

function isOperation(value: unknown): value is ImageEditOperation {
  return IMAGE_EDIT_OPERATIONS.includes(value as ImageEditOperation)
}

/**
 * Read the version off a part, or `null` when there is none.
 *
 * Tolerant by design. This data survives sync, backup and restore from other
 * builds, so a malformed or future-shaped record must degrade to "this is an
 * ordinary image" rather than throw inside a renderer.
 */
export function readImageEditVersion(part: unknown): ImageEditVersionV1 | null {
  const raw = (part as FileLikePart)?.[IMAGE_EDIT_PART_KEY]
  if (!raw || typeof raw !== "object") return null
  const record = raw as Record<string, unknown>
  if (record.schemaVersion !== IMAGE_EDIT_SCHEMA_VERSION) return null
  if (typeof record.lineageId !== "string" || record.lineageId.length === 0) return null
  if (typeof record.versionId !== "string" || record.versionId.length === 0) return null
  const parent = record.parentVersionId
  if (parent !== null && typeof parent !== "string") return null
  const operations = Array.isArray(record.operations) ? record.operations.filter(isOperation) : []
  const editedAt = typeof record.editedAt === "number" ? record.editedAt : 0

  return {
    schemaVersion: IMAGE_EDIT_SCHEMA_VERSION,
    lineageId: record.lineageId,
    versionId: record.versionId,
    parentVersionId: parent ?? null,
    operations,
    editedAt,
    ...(typeof record.providerId === "string" ? { providerId: record.providerId } : {}),
    ...(typeof record.modelId === "string" ? { modelId: record.modelId } : {}),
  }
}

/** Attach a version to a part, returning a new part. */
export function withImageEditVersion<T>(part: T, version: ImageEditVersionV1): T {
  return { ...(part as object), [IMAGE_EDIT_PART_KEY]: version } as T
}

/** Mint a version id. Also the idempotency key a retry must reuse. */
export function newImageEditVersionId(): string {
  return `iev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export interface ImageLineageEntry {
  /** The part itself, so a caller can render it without re-finding it. */
  part: unknown
  url: string
  /** `null` for the original. */
  version: ImageEditVersionV1 | null
  /** 0 for the original, then 1, 2, ... down the parent chain. */
  depth: number
}

export interface ImageLineage {
  lineageId: string
  /** Present unless the original was deleted from the message. */
  origin: ImageLineageEntry | null
  /** Origin first, then every derived version in chain order. */
  entries: ImageLineageEntry[]
}

/**
 * Group a message's image parts into lineages.
 *
 * Ordering inside a lineage follows the parent chain rather than the part
 * order, because a message can be rewritten by a sync leg that does not
 * preserve append order. Anything whose parent is missing (a version whose
 * parent part was deleted) is still emitted, ordered by `editedAt`, so an
 * orphan is visible rather than silently dropped.
 */
export function groupImageLineages(parts: readonly unknown[]): ImageLineage[] {
  const origins = new Map<string, ImageLineageEntry>()
  const derived = new Map<string, ImageLineageEntry[]>()
  const order: string[] = []

  for (const part of parts) {
    if (!isImagePart(part)) continue
    const url = (part as FileLikePart).url as string
    const version = readImageEditVersion(part)
    if (version === null) {
      if (!origins.has(url)) {
        origins.set(url, { part, url, version: null, depth: 0 })
        if (!order.includes(url)) order.push(url)
      }
      continue
    }
    const bucket = derived.get(version.lineageId)
    const entry: ImageLineageEntry = { part, url, version, depth: 0 }
    if (bucket) bucket.push(entry)
    else {
      derived.set(version.lineageId, [entry])
      if (!order.includes(version.lineageId)) order.push(version.lineageId)
    }
  }

  return order.map((lineageId) => {
    const origin = origins.get(lineageId) ?? null
    const entries = chainOrder(origin, derived.get(lineageId) ?? [])
    return { lineageId, origin, entries }
  })
}

/**
 * Walk the parent chain from the origin outward, then append anything left
 * over. The leftovers are versions whose parent no longer exists in the
 * message, which the rail still has to show.
 */
function chainOrder(
  origin: ImageLineageEntry | null,
  derived: ImageLineageEntry[]
): ImageLineageEntry[] {
  const byParent = new Map<string | null, ImageLineageEntry[]>()
  for (const entry of derived) {
    const key = entry.version?.parentVersionId ?? null
    const bucket = byParent.get(key)
    if (bucket) bucket.push(entry)
    else byParent.set(key, [entry])
  }
  for (const bucket of byParent.values()) {
    bucket.sort((a, b) => (a.version?.editedAt ?? 0) - (b.version?.editedAt ?? 0))
  }

  const ordered: ImageLineageEntry[] = []
  const seen = new Set<ImageLineageEntry>()

  if (origin) {
    origin.depth = 0
    ordered.push(origin)
    seen.add(origin)
  }

  const walk = (parentId: string | null, depth: number): void => {
    for (const entry of byParent.get(parentId) ?? []) {
      if (seen.has(entry)) continue
      entry.depth = depth
      ordered.push(entry)
      seen.add(entry)
      walk(entry.version?.versionId ?? null, depth + 1)
    }
  }
  walk(null, 1)

  for (const entry of derived) {
    if (seen.has(entry)) continue
    entry.depth = ordered.length
    ordered.push(entry)
    seen.add(entry)
  }
  return ordered
}

/** The most recently edited entry of a lineage, or the origin when unedited. */
export function latestImageVersion(lineage: ImageLineage): ImageLineageEntry | null {
  return lineage.entries.at(-1) ?? lineage.origin
}

/** Find the lineage that contains `url`, if any. */
export function lineageContaining(
  lineages: readonly ImageLineage[],
  url: string
): ImageLineage | null {
  return lineages.find((lineage) => lineage.entries.some((entry) => entry.url === url)) ?? null
}
