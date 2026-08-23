import type {
  WorkflowDependencyLock,
  WorkflowExecutionBinding,
  WorkflowVersion,
} from "./deployment"
import type { WorkflowInterface } from "./visual"
import type { GateThresholds } from "@/types/eval/gate"

export type WorkflowAppKind = "workflow" | "chatflow"

export type WorkflowAppBlock =
  | { id: string; type: "header"; showDescription: boolean }
  | { id: string; type: "input-form"; submitLabel?: string }
  | { id: string; type: "chat"; showSources: boolean }
  | { id: string; type: "result"; allowCopy: boolean; showSources: boolean }
  | { id: string; type: "footer"; text?: string }

export interface WorkflowAppLocalizedContent {
  title: string
  description?: string
  welcomeMessage?: string
  inputSubmitLabel?: string
  legalConsentLabel?: string
}

export interface WorkflowAppDraft {
  blocks: WorkflowAppBlock[]
  theme: {
    colorMode: "light" | "dark" | "system"
    primaryColor: string
    logoRef?: string
  }
  localized: Partial<Record<"en" | "zh-CN", WorkflowAppLocalizedContent>>
  access: {
    mode: "private" | "oidc" | "anonymous"
    oidcGroupIds: string[]
  }
  embed: {
    enabled: boolean
    allowedOrigins: string[]
  }
  customDomain?: {
    hostname: string
    verificationStatus: "pending" | "verified"
    verificationToken: string
    verifiedAt?: number
  }
  resultSharing: {
    enabled: boolean
    defaultTtlSeconds?: number
  }
  mcp: {
    enabled: boolean
    tokenVersion?: number
  }
  quota: {
    requestsPerMinute?: number
    concurrentRuns?: number
    dailyTokenBudget?: number
    dailyCostBudgetUsd?: number
  }
  contentPolicy: {
    inputModeration: boolean
    outputModeration: boolean
    maxInputBytes?: number
  }
  legal: {
    requireConsent: boolean
    termsUrl?: string
    privacyUrl?: string
  }
  reviewGate: {
    enabled: boolean
    requiredApprovals: number
    reviewerSubjectIds: string[]
    reviewerGroupIds: string[]
    requireNoBlockingComments: boolean
  }
  qualityGate: {
    enabled: boolean
    datasetId?: string
    thresholds: GateThresholds
    maxAvgLatencyMs?: number
    maxRunAgeMs: number
  }
  annotationReply: {
    enabled: boolean
    setId?: string
    threshold: number
    embeddingProfileId?: string
    embeddingProvider?: string
    embeddingModel?: string
    vectorBackend?: "native" | "qdrant" | "pinecone" | "weaviate" | "milvus" | "chroma"
  }
  knowledgeBindings: Record<string, string | string[]>
}

/** Mutable authoring projection; execution never reads `draft` directly. */
export interface WorkflowApp {
  id: string
  accountId: string
  workflowId: string
  kind: WorkflowAppKind
  slug: string
  draft: WorkflowAppDraft
  draftRevision: number
  currentReleaseId?: string
  publicationRevision: number
  createdAt: number
  updatedAt: number
  createdBy?: string
  updatedBy?: string
}

/** Immutable app + workflow artifact selected by the app's atomic pointer. */
export interface WorkflowAppRelease {
  id: string
  appId: string
  accountId: string
  workflowId: string
  appKind: WorkflowAppKind
  sequence: number
  appDraftRevision: number
  versionId: string
  versionDigest: string
  deploymentId: string
  deploymentRevision: number
  workflowInterface: WorkflowInterface
  dependencyLock: WorkflowDependencyLock
  snapshot: WorkflowAppDraft
  annotationRevisionId?: string
  qualityGateEvidence?: {
    runId?: string
    datasetId: string
    datasetVersion: number
    evaluatedAt: number
    failures: string[]
    override?: { actorSubjectId: string; reason: string; at: number }
  }
  createdAt: number
  createdBy?: string
}

export interface ResolvedWorkflowAppRelease {
  app: WorkflowApp
  release: WorkflowAppRelease
  version: WorkflowVersion
  binding: WorkflowExecutionBinding
}
