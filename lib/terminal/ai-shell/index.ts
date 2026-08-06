/**
 * Interactive AI Shell — barrel export.
 *
 * The AI Shell is a side-panel conversation that interprets natural
 * language intent into multi-step terminal execution plans. It comprises:
 *
 *  - **types** — shared type definitions (plans, steps, context, etc.)
 *  - **context-builder** — assembles terminal state for the LLM
 *  - **plan-generator** — LLM call to generate an execution plan
 *  - **plan-executor** — sequential step execution with error detection
 *  - **error-advisor** — suggests fixes when a step fails
 */

export type {
  AiShellPanelState,
  AiShellRole,
  AiShellMessage,
  StepStatus,
  ExecutionStep,
  PlanStatus,
  ExecutionPlan,
  AiShellContext,
  ErrorAdvisory,
  PlanGeneratorOptions,
  PlanExecutorOptions,
  StepProgressCallback,
  PlanStreamCallback,
  AiShellSession,
} from "./types"

export {
  buildAiShellContext,
  isContextPiiSafe,
  serializeContextForPiiCheck,
  MAX_RECENT_OUTPUT_LINES,
  MAX_RECENT_COMMANDS,
  MAX_LINE_LENGTH,
} from "./context-builder"
export type { ContextBuilderDeps } from "./context-builder"

export {
  generatePlan,
  buildPlanSystemPrompt,
  buildPlanUserPrompt,
  DEFAULT_MAX_STEPS,
} from "./plan-generator"
export type { PlanGeneratorDeps } from "./plan-generator"

export { executeStep, executePlan, DEFAULT_STEP_TIMEOUT_MS } from "./plan-executor"
export type { StepResult, PlanExecutionResult } from "./plan-executor"

export {
  getErrorAdvisory,
  buildErrorAdvisorSystemPrompt,
  buildErrorAdvisorPrompt,
} from "./error-advisor"
export type { ErrorAdvisorDeps } from "./error-advisor"
