/**
 * Runtime mirrors of `spec/internal.schema.json` (Router + Fusion contracts
 * 1.0.0). Every object is strict — unknown fields are rejected, exactly as the
 * JSON Schema's `additionalProperties: false` — and `schema_version` is pinned
 * to the contract version. `schemas.test.ts` proves parity against the vendored
 * JSON Schema with ajv over the bundled examples plus mutated negatives, so a
 * drift in either direction fails CI instead of silently diverging.
 *
 * Money crosses the API as a decimal string (`MoneyUSD`) and lives internally as
 * an integer microusd count; the `*_microusd` fields are bounded by
 * `Number.MAX_SAFE_INTEGER` like the schema.
 */

import { z } from "zod"

export const CONTRACT_SCHEMA_VERSION = "1.0.0" as const

const MAX_SAFE = 9007199254740991

const schemaVersion = z.literal(CONTRACT_SCHEMA_VERSION)
const uuid = z.uuid()
const dateTime = z.iso.datetime({ offset: true })
const nonNegInt = z.int().min(0)
const microusd = z.int().min(0).max(MAX_SAFE)
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)
const nullableString = z.string().nullable()

export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
  "reconciling",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]
export const RunStatusSchema = z.enum(RUN_STATUSES)

export const EXECUTION_MODES = ["direct", "cascade", "panel", "delegate"] as const
export type ExecutionMode = (typeof EXECUTION_MODES)[number]
export const ExecutionModeSchema = z.enum(EXECUTION_MODES)

export const TASK_KINDS = [
  "text.transform",
  "data.extract",
  "qa.knowledge",
  "research.synthesis",
  "reasoning.solve",
  "code.implement",
  "code.debug",
  "code.review",
  "agent.plan",
  "agent.execute",
  "unknown",
] as const
export type TaskKind = (typeof TASK_KINDS)[number]

export const PHASES = [
  "intake",
  "planning",
  "investigation",
  "execution",
  "verification",
  "review",
] as const
export type Phase = (typeof PHASES)[number]

export const DATA_CLASSES = ["public", "internal", "restricted"] as const
export type DataClass = (typeof DATA_CLASSES)[number]

export const VERIFICATION_STATUSES = ["passed", "failed", "inconclusive", "not_applicable"] as const
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number]

export const VERIFICATION_LEVELS = [
  "schema_only",
  "model_review",
  "tool_verified",
  "human_review",
  "mixed",
] as const
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number]

export const RUN_EVENT_TYPES = [
  "run.queued",
  "route.selected",
  "phase.changed",
  "call.started",
  "call.finished",
  "verification.completed",
  "approval.required",
  "billing.updated",
  "answer.delta",
  "answer.completed",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.expired",
] as const
export type RunEventType = (typeof RUN_EVENT_TYPES)[number]

/** Decimal USD string, at most 6 fractional digits, no leading zeros, < 1e6. */
export const MoneyUSDSchema = z.string().regex(/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$/)

export const MessageSchema = z.strictObject({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1).max(500000),
})

export const InputMessageSchema = z.strictObject({
  role: z.literal("user"),
  content: z.string().min(1).max(500000),
})

export const BudgetSchema = z.strictObject({
  max_cost_usd: MoneyUSDSchema,
  mode: z.enum(["strict", "tracked"]),
})

export const RunRequestSchema = z
  .strictObject({
    schema_version: schemaVersion,
    input_messages: z.array(InputMessageSchema).min(1).max(20),
    session_id: uuid.optional(),
    expected_session_version: nonNegInt.optional(),
    mode: z.enum(["auto", ...EXECUTION_MODES]),
    allowed_modes: z
      .array(ExecutionModeSchema)
      .min(1)
      .refine((modes) => new Set(modes).size === modes.length, { message: "uniqueItems" }),
    profile: z.enum(["economy", "balanced", "quality"]),
    budget: BudgetSchema,
    deadline_ms: z.int().min(1000).max(3600000),
    workspace_id: uuid.optional(),
    acceptance_profile_id: z.string().optional(),
    allow_degraded: z.boolean(),
    delivery: z.literal("verified_buffered"),
  })
  .superRefine((value, ctx) => {
    // JSON Schema `dependentRequired`: a stateful follow-up names both the
    // session and the version it expects, never one without the other.
    if ((value.session_id === undefined) !== (value.expected_session_version === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: value.session_id === undefined ? ["session_id"] : ["expected_session_version"],
        message: "session_id and expected_session_version must be provided together",
      })
    }
  })

export const RunAcceptedSchema = z.strictObject({
  schema_version: schemaVersion,
  run_id: uuid,
  session_id: uuid,
  session_version: nonNegInt,
  status: RunStatusSchema,
  version: nonNegInt,
  created_at: dateTime,
})

export const RoutingFeaturesSchema = z.strictObject({
  schema_version: schemaVersion,
  goal: z.string(),
  task: z.enum(TASK_KINDS),
  phase: z.enum(PHASES),
  language: z.string(),
  missing_information: z.array(z.string()),
  ambiguity: z.enum(["low", "medium", "high", "unknown"]),
  tool_need: z.enum(["none", "read_only", "sandbox_write", "external_write", "unknown"]),
  scope: z.enum(["single_item", "single_file", "multi_file", "cross_system", "unknown"]),
  failed_attempts: nonNegInt,
  verification_kinds: z.array(z.string()),
  source_revision: nullableString,
  feature_version: z.string(),
  context_truncated: z.boolean(),
})

const probability = z.number().min(0).max(1).nullable()

export const QualityEstimateSchema = z
  .strictObject({
    action_id: z.string(),
    p_pass: probability,
    group_pass_rate: probability,
    source: z.enum(["rule", "eval", "model"]),
    support_count: nonNegInt,
    in_distribution: z.boolean(),
    predictor_version: nullableString,
  })
  .superRefine((value, ctx) => {
    // Only a calibrated predictor may state an individual probability: rule and
    // grouped-eval sources carry p_pass=null, a model source must carry both a
    // probability and the predictor version that produced it.
    if ((value.source === "rule" || value.source === "eval") && value.p_pass !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["p_pass"],
        message: "p_pass must be null for rule/eval sources",
      })
    }
    if (value.source === "model") {
      if (value.p_pass === null) {
        ctx.addIssue({ code: "custom", path: ["p_pass"], message: "model source requires p_pass" })
      }
      if (value.predictor_version === null) {
        ctx.addIssue({
          code: "custom",
          path: ["predictor_version"],
          message: "model source requires predictor_version",
        })
      }
    }
  })

export const CandidateAssessmentSchema = z.strictObject({
  action_id: z.string(),
  eligible: z.boolean(),
  exclusion_reasons: z.array(z.string()),
  quality: QualityEstimateSchema,
  expected_cost_microusd: microusd,
  reserve_cost_microusd: microusd,
  estimated_p95_ms: nonNegInt,
})

export const RouteDecisionSchema = z.strictObject({
  schema_version: schemaVersion,
  decision_id: uuid,
  run_id: uuid,
  selected_action_id: nullableString,
  mode_selected: ExecutionModeSchema.nullable(),
  candidates: z.array(CandidateAssessmentSchema),
  reason_codes: z.array(z.string()),
  policy_version: z.string(),
  registry_version: z.string(),
  prompt_version: z.string(),
  classifier_version: z.string(),
  degraded: z.boolean(),
  created_at: dateTime,
})

export const EvidenceRefSchema = z.strictObject({
  artifact_id: uuid,
  content_sha256: sha256Hex,
  locator: z.string(),
  retrieved_at: dateTime,
})

export const ClaimSchema = z.strictObject({
  claim_id: z.string(),
  text: z.string(),
  evidence_refs: z.array(EvidenceRefSchema),
})

export const CandidateSchema = z.strictObject({
  schema_version: schemaVersion,
  candidate_id: z.string(),
  answer: z.string(),
  claims: z.array(ClaimSchema),
  assumptions: z.array(z.string()),
  open_questions: z.array(z.string()),
})

export const ContradictionSchema = z.strictObject({
  topic: z.string(),
  claim_ids: z.array(z.string()).min(1),
  resolution: z.enum(["resolved", "unresolved"]),
  summary: z.string(),
  evidence_refs: z.array(EvidenceRefSchema),
})

export const VerificationRequestSchema = z.strictObject({
  request_id: z.string(),
  kind: z.enum(["artifact_read", "source_check", "compute", "test"]),
  question: z.string(),
  artifact_ids: z.array(uuid),
})

export const JudgeReportSchema = z.strictObject({
  schema_version: schemaVersion,
  supported_claim_ids: z.array(z.string()),
  rejected_claim_ids: z.array(z.string()),
  contradictions: z.array(ContradictionSchema),
  missing_requirements: z.array(z.string()),
  verification_requests: z.array(VerificationRequestSchema),
  ready_to_synthesize: z.boolean(),
})

export const SubtaskSchema = z.strictObject({
  schema_version: schemaVersion,
  task_id: uuid,
  goal: z.string(),
  base_revision: z.string(),
  allowed_paths: z.array(z.string()).min(1),
  constraints: z.array(z.string()),
  acceptance: z.array(z.string()).min(1),
  tool_policy_id: z.string(),
  max_steps: z.int().min(1).max(20),
  artifact_namespace: z.string(),
})

export const WorkerResultSchema = z.strictObject({
  schema_version: schemaVersion,
  task_id: uuid,
  summary: z.string(),
  base_revision: z.string(),
  result_revision: z.string(),
  patch_artifact_id: uuid,
  claimed_check_ids: z.array(z.string()),
  open_questions: z.array(z.string()),
})

export const VerificationCheckSchema = z.strictObject({
  check_id: z.string(),
  kind: z.string(),
  status: z.enum(VERIFICATION_STATUSES),
  summary: z.string(),
  executed_by: z.enum(["runtime", "model", "human"]),
  artifact_refs: z.array(uuid),
})

export const VerificationReportSchema = z.strictObject({
  schema_version: schemaVersion,
  report_id: uuid,
  status: z.enum(VERIFICATION_STATUSES),
  level: z.enum(VERIFICATION_LEVELS),
  checks: z.array(VerificationCheckSchema),
  revision: nullableString,
  verifier_version: z.string(),
  artifact_refs: z.array(uuid),
})

export const BILLABLE_KINDS = [
  "ordinary_input",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
  "output",
  "reasoning_separate",
  "tool",
  "request",
  "other",
] as const
export type BillableKind = (typeof BILLABLE_KINDS)[number]

export const BillableItemSchema = z.strictObject({
  kind: z.enum(BILLABLE_KINDS),
  quantity: nonNegInt,
  unit: z.string(),
  amount_microusd: microusd,
  rate_version: z.string(),
})

export const COST_STATUSES = ["actual", "estimated", "pending"] as const
export type CostStatus = (typeof COST_STATUSES)[number]

export const UsageSchema = z.strictObject({
  input_uncached_tokens: nonNegInt,
  input_cache_read_tokens: nonNegInt,
  input_cache_write_tokens: nonNegInt,
  output_tokens: nonNegInt,
  reasoning_tokens: nonNegInt,
  reasoning_included_in_output: z.boolean(),
  billable_items: z.array(BillableItemSchema),
  cost_status: z.enum(COST_STATUSES),
  raw_usage_artifact_id: uuid.nullable(),
})

export const BillingSummarySchema = z.strictObject({
  budget_cap_microusd: microusd,
  spent_microusd: microusd,
  active_step_reservations_microusd: microusd,
  tenant_hold_microusd: microusd,
  status: z.enum(COST_STATUSES),
  overspend_microusd: microusd,
  model_calls: nonNegInt,
})

export const RunResultSchema = z.strictObject({
  answer: z.string(),
  answer_artifact_id: uuid,
  answer_sha256: sha256Hex,
  mode_executed: ExecutionModeSchema,
  quality_status: z.enum(["accepted", "degraded", "unknown"]),
  verification: VerificationReportSchema,
  delivery: z.enum(["answer", "patch_only", "workspace_updated"]),
  artifact_ids: z.array(uuid),
  warnings: z.array(z.string()),
})

export const APIErrorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()),
  trace_id: z.string(),
})

export const ErrorResponseSchema = z.strictObject({ error: APIErrorSchema })

export const RunSnapshotSchema = z.strictObject({
  schema_version: schemaVersion,
  run_id: uuid,
  session_id: uuid,
  session_version: nonNegInt,
  status: RunStatusSchema,
  phase: z.string(),
  version: nonNegInt,
  created_at: dateTime,
  deadline_at: dateTime,
  decision: RouteDecisionSchema.nullable(),
  result: RunResultSchema.nullable(),
  billing: BillingSummarySchema,
  error: APIErrorSchema.nullable(),
  pending_approval_id: uuid.nullable(),
  trace_id: z.string(),
})

export const ResumeRequestSchema = z
  .strictObject({
    kind: z.enum(["input", "approval"]),
    expected_run_version: nonNegInt,
    input_messages: z.array(InputMessageSchema).min(1).optional(),
    approval_id: uuid.optional(),
    decision: z.enum(["approve", "reject"]).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "input") {
      if (value.input_messages === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["input_messages"],
          message: "input resume requires input_messages",
        })
      }
      if (value.approval_id !== undefined || value.decision !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["kind"],
          message: "input resume must not carry an approval",
        })
      }
    } else {
      if (value.approval_id === undefined || value.decision === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["approval_id"],
          message: "approval resume requires approval_id and decision",
        })
      }
      if (value.input_messages !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["kind"],
          message: "approval resume must not carry input_messages",
        })
      }
    }
  })

export const FeedbackRequestSchema = z.strictObject({
  rating: z.enum(["positive", "negative"]),
  comment: z.string().max(10000).optional(),
})

export const AcknowledgementSchema = z.strictObject({ accepted: z.boolean() })

export const SessionSnapshotSchema = z.strictObject({
  session_id: uuid,
  version: nonNegInt,
  active_run_id: uuid.nullable(),
  messages: z.array(MessageSchema),
})

export const ArtifactMetadataSchema = z.strictObject({
  artifact_id: uuid,
  content_sha256: z.string(),
  media_type: z.string(),
  size_bytes: nonNegInt,
  read_url: z.url(),
  expires_at: dateTime,
})

export const ModelPublicSchema = z.strictObject({
  alias: z.string(),
  revision: z.string(),
  input_modalities: z.array(z.enum(["text", "image"])),
  supports_tools: z.boolean(),
  supports_json_schema: z.boolean(),
  context_limit: z.int().min(1),
  max_output_tokens: z.int().min(1),
})

export const ModelsResponseSchema = z.strictObject({ data: z.array(ModelPublicSchema) })

export const CHAT_ROUTER_MODELS = [
  "router/auto",
  "router/direct",
  "router/cascade",
  "router/panel",
] as const
export type ChatRouterModel = (typeof CHAT_ROUTER_MODELS)[number]

export const ChatRequestSchema = z.strictObject({
  model: z.enum(CHAT_ROUTER_MODELS),
  messages: z.array(MessageSchema).min(1).max(100),
  stream: z.boolean().optional(),
  n: z.int().min(1).max(1).optional(),
  response_format: z
    .strictObject({
      type: z.enum(["text", "json_schema"]),
      json_schema: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  routing: z.strictObject({
    profile: z.enum(["economy", "balanced", "quality"]),
    budget: BudgetSchema,
    deadline_ms: z.int().min(1000).max(3600000),
    allow_degraded: z.boolean(),
  }),
})

export const ChatResponseSchema = z.strictObject({
  id: z.string(),
  object: z.literal("chat.completion"),
  created: nonNegInt,
  model: z.string(),
  choices: z
    .array(
      z.strictObject({
        index: nonNegInt,
        message: MessageSchema,
        finish_reason: z.enum(["stop", "length"]),
      })
    )
    .min(1)
    .max(1),
  usage: z.strictObject({
    prompt_tokens: nonNegInt,
    completion_tokens: nonNegInt,
    total_tokens: nonNegInt,
  }),
  routing: z.strictObject({
    run_id: uuid,
    mode_executed: ExecutionModeSchema,
    degraded: z.boolean(),
    billing: BillingSummarySchema,
  }),
})

export const RunEventSchema = z.strictObject({
  schema_version: schemaVersion,
  run_id: uuid,
  seq: z.int().min(1),
  event_type: z.enum(RUN_EVENT_TYPES),
  timestamp: dateTime,
  payload: z.record(z.string(), z.unknown()),
})

export const HealthSchema = z.strictObject({
  status: z.enum(["ok", "not_ready"]),
  checks: z.record(z.string(), z.boolean()),
})

export const ProviderDeploymentSchema = z.strictObject({
  id: z.string(),
  provider: z.enum(["fake", "openrouter", "anthropic"]),
  model_revision: z.string(),
  credential_ref: nullableString,
  region: z.string(),
  data_classes: z.array(z.enum(DATA_CLASSES)),
  context_limit: z.int().min(1),
  max_output_tokens: z.int().min(1),
  supports_tools: z.boolean(),
  supports_json_schema: z.boolean(),
  usage_lookup: z.boolean(),
  provider_idempotency: z.boolean(),
  cache_mode: z.enum(["none", "automatic", "explicit"]),
  rate_card_id: z.string(),
  enabled: z.boolean(),
})

export const RateCardSchema = z.strictObject({
  id: z.string(),
  example_only: z.boolean(),
  currency: z.literal("USD"),
  ordinary_input_per_million: z.string(),
  output_per_million: z.string(),
  cache_read_per_million: z.string(),
  cache_write_5m_per_million: z.string(),
  cache_write_1h_per_million: z.string(),
})

export const ModelRegistrySchema = z.strictObject({
  schema_version: schemaVersion,
  registry_version: z.string(),
  example_only: z.boolean(),
  deployments: z.array(ProviderDeploymentSchema).min(1),
  aliases: z.record(z.string(), z.string()),
  rate_cards: z.array(RateCardSchema).min(1),
})

export const ActionConfigSchema = z.strictObject({
  id: z.string(),
  mode: ExecutionModeSchema,
  roles: z.record(z.string(), z.string()),
  prompt_version: z.string(),
  verifier_profile: z.string(),
  enabled: z.boolean(),
})

export const PolicyLimitsSchema = z.strictObject({
  max_model_calls: z.int().min(1),
  transport_attempts_per_call: z.int().min(1),
  max_format_repairs: nonNegInt,
  max_reroutes: nonNegInt,
  panel_size: z.int().min(2).max(3),
  panel_min_candidates: z.int().min(2).max(3),
  panel_evidence_rounds: z.int().min(0).max(1),
  worker_model_turns: z.int().min(1),
  worker_tool_operations: z.int().min(1),
  worker_repair_rounds: z.int().min(0).max(1),
  lead_takeovers: z.int().min(0).max(1),
  run_lease_seconds: z.int().min(1),
  heartbeat_seconds: z.int().min(1),
  deadline_default_ms: z.int().min(1000).max(3600000),
})

export const PolicyConfigSchema = z.strictObject({
  schema_version: schemaVersion,
  policy_version: z.string(),
  example_only: z.boolean(),
  production_auto_baseline_only: z.boolean(),
  classifier: z.strictObject({
    implementation: z.enum(["rules", "llm_schema", "encoder"]),
    version: z.string(),
    input_token_cap: z.int().min(1),
    timeout_ms: z.int().min(1),
    cache_ttl_seconds: z.int().min(1),
  }),
  limits: PolicyLimitsSchema,
  switch_margin: z.number().min(0).max(1),
  default_delivery: z.literal("verified_buffered"),
  answer_cache_enabled: z.boolean(),
  actions: z.array(ActionConfigSchema).min(1),
})

export type Message = z.infer<typeof MessageSchema>
export type InputMessage = z.infer<typeof InputMessageSchema>
export type Budget = z.infer<typeof BudgetSchema>
export type RunRequest = z.infer<typeof RunRequestSchema>
export type RunAccepted = z.infer<typeof RunAcceptedSchema>
export type RoutingFeatures = z.infer<typeof RoutingFeaturesSchema>
export type QualityEstimate = z.infer<typeof QualityEstimateSchema>
export type CandidateAssessment = z.infer<typeof CandidateAssessmentSchema>
export type RouteDecision = z.infer<typeof RouteDecisionSchema>
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>
export type Claim = z.infer<typeof ClaimSchema>
export type Candidate = z.infer<typeof CandidateSchema>
export type Contradiction = z.infer<typeof ContradictionSchema>
export type VerificationRequest = z.infer<typeof VerificationRequestSchema>
export type JudgeReport = z.infer<typeof JudgeReportSchema>
export type Subtask = z.infer<typeof SubtaskSchema>
export type WorkerResult = z.infer<typeof WorkerResultSchema>
export type VerificationCheck = z.infer<typeof VerificationCheckSchema>
export type VerificationReport = z.infer<typeof VerificationReportSchema>
export type BillableItem = z.infer<typeof BillableItemSchema>
export type Usage = z.infer<typeof UsageSchema>
export type BillingSummary = z.infer<typeof BillingSummarySchema>
export type RunResult = z.infer<typeof RunResultSchema>
export type APIError = z.infer<typeof APIErrorSchema>
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>
export type ResumeRequest = z.infer<typeof ResumeRequestSchema>
export type FeedbackRequest = z.infer<typeof FeedbackRequestSchema>
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>
export type ModelPublic = z.infer<typeof ModelPublicSchema>
export type ChatRequest = z.infer<typeof ChatRequestSchema>
export type ChatResponse = z.infer<typeof ChatResponseSchema>
export type RunEvent = z.infer<typeof RunEventSchema>
export type ProviderDeployment = z.infer<typeof ProviderDeploymentSchema>
export type RateCard = z.infer<typeof RateCardSchema>
export type ModelRegistry = z.infer<typeof ModelRegistrySchema>
export type ActionConfig = z.infer<typeof ActionConfigSchema>
export type PolicyLimits = z.infer<typeof PolicyLimitsSchema>
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>

/**
 * Every `$defs` entry of the vendored JSON Schema, by name. The parity test
 * asserts this map covers the schema exactly — a definition added upstream
 * without a mirror here fails the build.
 */
export const CONTRACT_SCHEMAS = {
  MoneyUSD: MoneyUSDSchema,
  Message: MessageSchema,
  InputMessage: InputMessageSchema,
  Budget: BudgetSchema,
  RunRequest: RunRequestSchema,
  RunAccepted: RunAcceptedSchema,
  RoutingFeatures: RoutingFeaturesSchema,
  QualityEstimate: QualityEstimateSchema,
  CandidateAssessment: CandidateAssessmentSchema,
  RouteDecision: RouteDecisionSchema,
  EvidenceRef: EvidenceRefSchema,
  Claim: ClaimSchema,
  Candidate: CandidateSchema,
  Contradiction: ContradictionSchema,
  VerificationRequest: VerificationRequestSchema,
  JudgeReport: JudgeReportSchema,
  Subtask: SubtaskSchema,
  WorkerResult: WorkerResultSchema,
  VerificationCheck: VerificationCheckSchema,
  VerificationReport: VerificationReportSchema,
  BillableItem: BillableItemSchema,
  Usage: UsageSchema,
  BillingSummary: BillingSummarySchema,
  RunResult: RunResultSchema,
  APIError: APIErrorSchema,
  ErrorResponse: ErrorResponseSchema,
  RunSnapshot: RunSnapshotSchema,
  ResumeRequest: ResumeRequestSchema,
  FeedbackRequest: FeedbackRequestSchema,
  Acknowledgement: AcknowledgementSchema,
  SessionSnapshot: SessionSnapshotSchema,
  ArtifactMetadata: ArtifactMetadataSchema,
  ModelPublic: ModelPublicSchema,
  ModelsResponse: ModelsResponseSchema,
  ChatRequest: ChatRequestSchema,
  ChatResponse: ChatResponseSchema,
  RunEvent: RunEventSchema,
  Health: HealthSchema,
  ProviderDeployment: ProviderDeploymentSchema,
  ModelRegistry: ModelRegistrySchema,
  ActionConfig: ActionConfigSchema,
  PolicyConfig: PolicyConfigSchema,
} as const

export type ContractName = keyof typeof CONTRACT_SCHEMAS
