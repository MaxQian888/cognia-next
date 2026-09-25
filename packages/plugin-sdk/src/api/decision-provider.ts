/**
 * Portable System-1 decision contracts (ADR-0194): the typed question /
 * answer shapes, the provider contribution types, and the pure request
 * validator a provider can run before its own forward pass.
 *
 * Consumers call `ctx.decisions.decide(...)`; providers declare
 * `manifest.decisionProviders[]` (python plugins back them with
 * `@cognia.contribution("<id>")`) or call `ctx.decisions.registerProvider`.
 */

export { defineDecisionProvider } from "../define/define-decision-provider"

export type { PluginDecisionsAPI } from "@/lib/plugin/api/decisions-api"
export type {
  PluginDecisionProviderDef,
  PluginDecisionProviderFactory,
  PluginDecisionProviderFactoryContext,
  PluginDecisionProviderInput,
  PluginDecisionRegistration,
} from "@/types/plugin/plugin-decisions"
export type {
  ChoiceAnswer,
  ChoiceQuestion,
  DecisionAnswer,
  DecisionAnswers,
  DecisionError,
  DecisionErrorKind,
  DecisionFailure,
  DecisionProvider,
  DecisionProviderInfo,
  DecisionProviderLimits,
  DecisionProviderResponse,
  DecisionProviderStatus,
  DecisionQuestion,
  DecisionQuestions,
  DecisionQuestionTruncation,
  DecisionQuestionType,
  DecisionRequest,
  DecisionResult,
  DecisionRouting,
  DecisionState,
  DecisionSuccess,
  NoulAnswer,
  NoulQuestion,
  ScoreAnswer,
  ScoreQuestion,
} from "@/types/decisions"
export { DECISION_ERROR_KINDS } from "@/types/decisions"

export {
  MAX_CHOICE_OPTIONS,
  validateDecisionQuestions,
  validateDecisionRequest,
} from "@/lib/decisions/validate"
export { scoreFraction } from "@/lib/decisions/normalize"
