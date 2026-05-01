/**
 * Public surface of the twin runtime subsystem.
 */

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
