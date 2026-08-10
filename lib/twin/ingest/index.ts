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

export {
  BINARY_TWIN_FORMATS,
  detectSourceFormat,
  dispatchSource,
  listSupportedExtensions,
  listSupportedFormats,
} from "./dispatch"
export { hasNoLeakingPii, redactText, unredactText } from "@cognia/redact"
export type { RedactionRecord, RedactionResult, PiiKind } from "@cognia/redact"
export { prepareChunks } from "./chunk"
export { embedRedactedChunks } from "./embed"
export { persistChunks, vectorCollectionName } from "./persist"
export { runIngestJob } from "./job-runner"
export { parseSource } from "./parse"
export { registerTwinSource, type RegisterTwinSourceResult } from "./source-registration"

/**
 * Queue an ingest job for the worker to pick up. Returns the freshly-
 * created `TwinJob` row so the caller can subscribe to its progress.
 * The `kind` field is set to `"ingest"` automatically.
 */
export async function enqueueIngestJob(draft: Omit<TwinJobDraft, "kind">): Promise<TwinJob> {
  return createTwinJob({ ...draft, kind: "ingest" })
}
