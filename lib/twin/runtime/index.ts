/**
 * Public surface of the twin runtime subsystem.
 */

export type { TwinDepsForBuild } from "./build-deps"
export { tryBuildTwinDeps } from "./build-deps"

export type {
  ApplyTwinContextDeps,
  ApplyTwinContextInput,
  ApplyTwinContextResult,
  TwinRuntimeEmbeddingConfig,
} from "./apply-twin-context"
export { applyTwinContext } from "./apply-twin-context"

export type { ApplyTemplateInput, AppliedTemplate } from "./system-prompt-template"
export { applySystemPromptTemplate } from "./system-prompt-template"

export type { FewShotSelectorInput, ScoredStyleSample } from "./few-shot-selector"
export { selectFewShotSamples } from "./few-shot-selector"

export type { TwinInjectLogEntry } from "./inject-log"
export { recordTwinInject, readTwinInjectLog, subscribeTwinInjectLog } from "./inject-log"

export type {
  TwinEffectiveEmbedding,
  TwinEmbeddingModelRef,
  TwinEmbeddingSource,
} from "./twin-embedding"
export {
  TWIN_EMBEDDING_REBUILD_REQUIRED,
  TWIN_EMBEDDING_UNCONFIGURED,
  resolveTwinEmbeddingConfig,
  twinEmbeddingFingerprint,
} from "./twin-embedding"
export type { TwinEmbeddingPlan, TwinEmbeddingStatus } from "./twin-embedding-status"
export { getTwinEmbeddingStatus, loadTwinEmbeddingPlan } from "./twin-embedding-status"
