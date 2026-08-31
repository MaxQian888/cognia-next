export type EvalMode = "model" | "agent"
export type EvalRuntimeTarget = "web" | "desktop"
export type EvalCapability =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "tool"
  | "structured-output"
  | "rag"
  | "trajectory"

export interface EvalContentPart {
  type: "text" | "asset"
  text?: string
  assetId?: string
  mediaType?: string
  name?: string
}

export interface EvalProjectDataset {
  datasetId: string
  version: number
  digest: string
  caseIds: string[]
  holdoutCaseIds: string[]
  requiredModalities: EvalCapability[]
  mediaClearance?: "local-only" | "scanned" | "manual"
}

export interface EvalVariantPrice {
  inputPerMillion: number
  outputPerMillion: number
  currency: string
}

export interface EvalVariant {
  id: string
  name: string
  kind: "model" | "chat" | "team" | "workflow"
  providerId?: string
  deploymentId?: string
  modelId?: string
  targetId?: string
  runtimeTarget: EvalRuntimeTarget
  isLocal: boolean
  price?: EvalVariantPrice
  capabilities: EvalCapability[]
  available: boolean
  credentialReady: boolean
  runtimeReady?: boolean
  catalogFingerprint?: string
  parameters?: Record<string, unknown>
}

export interface EvalDecisionDimension {
  metric: string
  direction: "maximize" | "minimize"
  weight: number
}

export interface EvalDecisionConstraint {
  metric: string
  operator: "gte" | "lte" | "gt" | "lt"
  value: number
}

export interface EvalDecisionPolicy {
  formal: boolean
  dimensions: EvalDecisionDimension[]
  constraints: EvalDecisionConstraint[]
  confidenceLevel: number
  minimumEffectiveCases: number
}

export interface EvalBudgetPolicy {
  currency: string
  hardCap: number
  confirmed: boolean
}

export interface EvalJudgePolicy {
  enabled: boolean
  providerId?: string
  modelId?: string
  isLocal?: boolean
  price?: EvalVariantPrice
  maxOutputTokens?: number
  calibrated: boolean
  anchorCount: number
  kappa: number
  accuracy: number
  secondJudgeProviderId?: string
  secondJudgeModelId?: string
  secondJudgeIsLocal?: boolean
  secondJudgePrice?: EvalVariantPrice
}

export interface EvalPrivacyPolicy {
  cloudPiiMode: "redact"
  mediaClearance: "local-only" | "scanned" | "manual"
}

export interface EvalProject {
  id: string
  name: string
  description?: string
  mode: EvalMode
  dataset: EvalProjectDataset
  variants: EvalVariant[]
  decisionPolicy: EvalDecisionPolicy
  budget: EvalBudgetPolicy
  judgePolicy: EvalJudgePolicy
  privacyPolicy: EvalPrivacyPolicy
  retentionDays: number
  createdAt: number
  updatedAt: number
}

export type EvalExperimentState =
  | "draft"
  | "preflight"
  | "queued"
  | "running"
  | "paused"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled"

export interface EvalExperimentManifest {
  id: string
  projectId: string
  projectRevision: string
  dataset: EvalProjectDataset
  variants: EvalVariant[]
  mode: EvalMode
  appVersion: string
  scorerVersions: Record<string, string>
  privacyPolicy: EvalPrivacyPolicy
  randomSeed: number
  budget: EvalBudgetPolicy
  judgePolicy: EvalJudgePolicy
  decisionPolicy: EvalDecisionPolicy
  retentionDays: number
  adaptiveRepetitions: { stageOne: 1; maximum: 3 }
  environmentCompatibility: EvalEnvironmentCompatibility
  createdAt: number
}

export interface EvalEnvironmentCompatibility {
  checkedAt: number
  runtimeByVariant: Record<
    string,
    {
      available: boolean
      reason?: string
    }
  >
  storage: {
    status: "available" | "insufficient" | "unknown"
    requiredBytes: number
    availableBytes?: number
  }
}

export type EvalTaskState =
  "queued" | "running" | "paused" | "interrupted" | "completed" | "failed" | "cancelled"

export interface EvalTask {
  id: string
  experimentId: string
  variantId: string
  caseId: string
  repetition: 1 | 2 | 3
  state: EvalTaskState
  attempt: number
  reservedCost: number
  estimatedWorstCaseCost?: number
  nextAttemptAt?: number
  providerRequestId?: string
  idempotencyKey?: string
  interruptionSpendAmbiguous?: boolean
  updatedAt: number
}

export interface EvalPreflightIssue {
  code:
    | "DATASET_EMPTY"
    | "TOO_FEW_VARIANTS"
    | "VARIANT_UNAVAILABLE"
    | "CREDENTIAL_MISSING"
    | "VARIANT_INCOMPATIBLE"
    | "PRICE_REQUIRED"
    | "HOLDOUT_TOO_SMALL"
    | "JUDGE_REQUIRED"
    | "JUDGE_PRICE_REQUIRED"
    | "SECOND_JUDGE_REQUIRED"
    | "SECOND_JUDGE_PRICE_REQUIRED"
    | "SECOND_JUDGE_NOT_INDEPENDENT"
    | "JUDGE_NOT_INDEPENDENT"
    | "JUDGE_CALIBRATION_FAILED"
    | "MEDIA_CLEARANCE_REQUIRED"
    | "BUDGET_CONFIRMATION_REQUIRED"
    | "RUNTIME_UNAVAILABLE"
    | "ENVIRONMENT_CHECK_REQUIRED"
    | "DISK_QUOTA_INSUFFICIENT"
    | "DISK_QUOTA_UNKNOWN"
    | "DECISION_WEIGHT_INVALID"
    | "DECISION_CONSTRAINT_INVALID"
    | "CONFIDENCE_LEVEL_INVALID"
    | "MINIMUM_CASES_INVALID"
    | "RETENTION_INVALID"
  severity: "error" | "warning"
  message: string
  variantId?: string
}

export interface EvalPreflightResult {
  ok: boolean
  issues: EvalPreflightIssue[]
  compatibleVariantIds: string[]
  effectiveCaseIds: string[]
}

export interface EvalMetricInterval {
  low: number
  high: number
}

export interface EvalCandidateEvidence {
  variantId: string
  effectiveCases: number
  metrics: Record<string, number>
  intervals: Record<string, EvalMetricInterval>
  calibrationPassed: boolean
}

export type EvalNoConclusionReason =
  | "insufficient_cases"
  | "calibration_failed"
  | "review_pending"
  | "no_candidate_satisfies_constraints"
  | "confidence_overlap"

export interface EvalRecommendationResult {
  status: "recommended" | "no_conclusion"
  recommendedVariantId?: string
  reason?: EvalNoConclusionReason
  paretoVariantIds: string[]
  utilityByVariant: Record<string, number>
  excluded: Array<{
    variantId: string
    reason: "constraint_failed" | "insufficient_cases" | "calibration_failed" | "dominated"
  }>
}

export interface EvalPortableManifest {
  schema: "cognia-eval/v2"
  exportedAt: string
  project: {
    id: string
    name: string
    mode: EvalMode
    datasetDigest: string
  }
  experiment: {
    id: string
    status: EvalExperimentState
    randomSeed: number
    appVersion: string
  }
  variants: Array<{
    id: string
    name: string
    providerId?: string
    modelId?: string
  }>
  aggregates: Array<Record<string, unknown>>
  metadata?: Record<string, unknown>
}
