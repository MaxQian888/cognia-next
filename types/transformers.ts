/**
 * Stub for `@/types/transformers`. Cognia's source uses this module path
 * but does not actually ship the file — the only consumer is
 * `lib/vector/embedding.ts`, which references the `TransformersErrorCode`
 * type to label runtime-unavailability errors when the optional
 * Transformers.js / @huggingface/transformers backend cannot run.
 *
 * cognia-next does not ship a local Transformers.js runtime in the MVP
 * (the twin pipeline uses cloud embedding providers via the AI SDK), so
 * this stays a thin type alias. Expand the union if a future runtime
 * adds more failure codes.
 */
export type TransformersErrorCode =
  | "runtime_unavailable"
  | "model_load_failed"
  | "worker_unavailable"
  | "out_of_memory"
  | (string & {})
