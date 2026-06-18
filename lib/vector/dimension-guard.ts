/**
 * Embedding-dimension safety guard.
 *
 * Switching embedding provider/model changes the output vector dimension. A
 * collection is created with a fixed dimension; writing or querying it with a
 * differently-sized vector silently corrupts results (cloud backends error or
 * return garbage; sqlite-vec rejects the row). This guard blocks the operation
 * with an actionable message BEFORE any corruption, rather than auto-dropping
 * data.
 *
 * The comparison uses the ACTUAL vector length we are about to use against the
 * collection's stored dimension — ground truth, no model lookup needed. (The
 * catalog's `expectedEmbeddingDimension` is used separately for the pre-flight
 * UI hint, before any embedding has been generated.)
 */

import type { IVectorStore } from "./store"

export interface DimensionMismatchContext {
  provider?: string
  model?: string
}

export class EmbeddingDimensionMismatchError extends Error {
  readonly collection: string
  readonly existing: number
  readonly actual: number
  readonly provider?: string
  readonly model?: string

  constructor(args: {
    collection: string
    existing: number
    actual: number
    provider?: string
    model?: string
  }) {
    const modelPart = args.model ? ` (model "${args.model}")` : ""
    super(
      `Embedding dimension mismatch for collection "${args.collection}": it was built with ${args.existing} dimensions, but the current embedding config${modelPart} produces ${args.actual} dimensions. Recreate the collection (re-ingest after clearing it) or switch the embedding model back to one that produces ${args.existing} dimensions.`
    )
    this.name = "EmbeddingDimensionMismatchError"
    this.collection = args.collection
    this.existing = args.existing
    this.actual = args.actual
    this.provider = args.provider
    this.model = args.model
  }
}

/**
 * Pure check. Throws {@link EmbeddingDimensionMismatchError} when both values
 * are known and differ; otherwise no-op (unknown dimension → can't conflict).
 */
export function assertDimensionCompatible(args: {
  collection: string
  existing: number | undefined | null
  actual: number | undefined | null
  provider?: string
  model?: string
}): void {
  const { collection, existing, actual, provider, model } = args
  if (existing == null || actual == null) return
  if (existing === actual) return
  throw new EmbeddingDimensionMismatchError({ collection, existing, actual, provider, model })
}

/**
 * Fetch the collection's stored dimension and assert the about-to-be-used
 * vector length matches it. A missing collection (not yet created) is fine —
 * it will be created with the right dimension, so we no-op.
 */
export async function ensureCollectionDimensionCompatible(
  store: Pick<IVectorStore, "getCollectionInfo">,
  collection: string,
  actualDimension: number | undefined,
  context?: DimensionMismatchContext
): Promise<void> {
  if (actualDimension == null) return

  let existing: number | undefined
  try {
    const info = await store.getCollectionInfo(collection)
    existing = info?.dimension
  } catch {
    // Collection does not exist yet → nothing to guard against.
    return
  }

  assertDimensionCompatible({
    collection,
    existing,
    actual: actualDimension,
    provider: context?.provider,
    model: context?.model,
  })
}
