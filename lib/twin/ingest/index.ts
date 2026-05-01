/**
 * Public surface of the twin ingest subsystem.
 *
 * Most callers should use either:
 *   • `enqueueIngestJob` from `@/lib/twin/ingest` (queue a job for the
 *     scheduler to run), or
 *   • `runIngestJob` directly when the caller wants synchronous execution
 *     (tests, CLI tools).
 */

import { createTwinJob, type TwinJobDraft } from "@/lib/db/twin-jobs"
import type { TwinJob } from "@/types/twin"

export type { RawSource, ParsedSource } from "./parse"
export type { PersistInput, PersistResult } from "./persist"
export type { EmbeddingConfig, EmbeddingResult } from "./embed"
export type { PreparedChunk, ChunkInput } from "./chunk"
export type { DispatchResult } from "./dispatch"
export type { RunIngestInput, RunIngestResult } from "./job-runner"

export { detectSourceFormat, dispatchSource, listSupportedFormats } from "./dispatch"
export { hasNoLeakingPii, redactText, unredactText } from "./redact"
export type { RedactionRecord, RedactionResult, PiiKind } from "./redact"
export { prepareChunks } from "./chunk"
export { embedRedactedChunks } from "./embed"
export { persistChunks, vectorCollectionName } from "./persist"
export { runIngestJob } from "./job-runner"
export { parseSource } from "./parse"

/**
 * Queue an ingest job for the scheduler executor (`twin-distill-executor`)
 * to pick up. Returns the freshly-created `TwinJob` row so the caller can
 * subscribe to its progress.
 */
export async function enqueueIngestJob(draft: TwinJobDraft): Promise<TwinJob> {
  return createTwinJob({ ...draft, kind: "ingest" })
}
