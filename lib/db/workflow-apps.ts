import type {
  ResolvedWorkflowAppRelease,
  WorkflowApp,
  WorkflowAppDraft,
  WorkflowAppKind,
  WorkflowAppRelease,
} from "@/types/workflow/app"
import { createWorkflowDependencyLockForVersion } from "@/lib/workflow/runtime/execution-authority"
import { assertKnowledgeBaseRevisionBindings } from "@/lib/knowledge-base/revisions"
import {
  assertWorkflowReviewGate,
  markWorkflowReviewPublished,
} from "@/lib/workflow/review/review-service"
import {
  assertWorkflowDeploymentQuality,
  type WorkflowQualityGateOverride,
} from "@/lib/workflow/quality/deployment-gate"
import { assertWorkflowPluginPublicationPreflight } from "@/lib/workflow/apps/plugin-publication-preflight"
import { workflowVersionDigest } from "@/lib/workflow/versioning/version-snapshot"
import { getDb } from "./schema"

const APP_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const HEX_COLOR = /^#[0-9a-f]{6}$/i

const DEFAULT_REVIEW_GATE: WorkflowAppDraft["reviewGate"] = {
  enabled: false,
  requiredApprovals: 1,
  reviewerSubjectIds: [],
  reviewerGroupIds: [],
  requireNoBlockingComments: true,
}
const DEFAULT_ANNOTATION_REPLY: WorkflowAppDraft["annotationReply"] = {
  enabled: false,
  threshold: 0.85,
}
const DEFAULT_QUALITY_GATE: WorkflowAppDraft["qualityGate"] = {
  enabled: false,
  thresholds: { minPassAt1: 0.8, maxUngradedRatio: 0.1 },
  maxRunAgeMs: 7 * 24 * 60 * 60 * 1_000,
}

export class WorkflowAppConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkflowAppConflictError"
  }
}

export class WorkflowAppValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkflowAppValidationError"
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export function defaultWorkflowAppDraft(kind: WorkflowAppKind): WorkflowAppDraft {
  return {
    blocks:
      kind === "chatflow"
        ? [
            { id: "header", type: "header", showDescription: true },
            { id: "chat", type: "chat", showSources: true },
            { id: "footer", type: "footer" },
          ]
        : [
            { id: "header", type: "header", showDescription: true },
            { id: "input", type: "input-form" },
            { id: "result", type: "result", allowCopy: true, showSources: true },
            { id: "footer", type: "footer" },
          ],
    theme: { colorMode: "system", primaryColor: "#2563eb" },
    localized: {},
    access: { mode: "private", oidcGroupIds: [] },
    embed: { enabled: false, allowedOrigins: [] },
    resultSharing: { enabled: false },
    mcp: { enabled: false },
    quota: {},
    contentPolicy: { inputModeration: true, outputModeration: true },
    legal: { requireConsent: false },
    reviewGate: clone(DEFAULT_REVIEW_GATE),
    qualityGate: clone(DEFAULT_QUALITY_GATE),
    annotationReply: clone(DEFAULT_ANNOTATION_REPLY),
    knowledgeBindings: {},
  }
}

function validateOrigins(origins: readonly string[]): void {
  for (const origin of origins) {
    let url: URL
    try {
      url = new URL(origin)
    } catch {
      throw new WorkflowAppValidationError(`Invalid embed origin: ${origin}`)
    }
    if (url.origin !== origin || !["https:", "http:"].includes(url.protocol)) {
      throw new WorkflowAppValidationError(
        `Embed origin must be an exact HTTP(S) origin: ${origin}`
      )
    }
  }
}

function validateCustomDomain(domain: WorkflowAppDraft["customDomain"]): void {
  if (!domain) return
  const hostname = domain.hostname.toLowerCase()
  if (
    hostname !== domain.hostname ||
    hostname.length > 253 ||
    !hostname.includes(".") ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      hostname
    )
  ) {
    throw new WorkflowAppValidationError("customDomain.hostname must be a valid public hostname")
  }
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(domain.verificationToken)) {
    throw new WorkflowAppValidationError("customDomain.verificationToken is invalid")
  }
  if (domain.verificationStatus === "verified" && !domain.verifiedAt) {
    throw new WorkflowAppValidationError("Verified custom domains require verifiedAt")
  }
}

function positiveInteger(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new WorkflowAppValidationError(`${field} must be a positive integer`)
  }
}

export function validateWorkflowAppDraft(draft: WorkflowAppDraft): void {
  if (!HEX_COLOR.test(draft.theme.primaryColor)) {
    throw new WorkflowAppValidationError("theme.primaryColor must be a six-digit hex color")
  }
  const blockIds = new Set<string>()
  for (const block of draft.blocks) {
    if (!block.id || blockIds.has(block.id)) {
      throw new WorkflowAppValidationError("App block ids must be non-empty and unique")
    }
    blockIds.add(block.id)
  }
  validateOrigins(draft.embed.allowedOrigins)
  validateCustomDomain(draft.customDomain)
  positiveInteger(draft.resultSharing.defaultTtlSeconds, "resultSharing.defaultTtlSeconds")
  if ((draft.resultSharing.defaultTtlSeconds ?? 0) > 30 * 24 * 60 * 60) {
    throw new WorkflowAppValidationError("resultSharing.defaultTtlSeconds cannot exceed 30 days")
  }
  positiveInteger(draft.quota.requestsPerMinute, "quota.requestsPerMinute")
  positiveInteger(draft.quota.concurrentRuns, "quota.concurrentRuns")
  positiveInteger(draft.quota.dailyTokenBudget, "quota.dailyTokenBudget")
  positiveInteger(draft.contentPolicy.maxInputBytes, "contentPolicy.maxInputBytes")
  const reviewGate = draft.reviewGate ?? DEFAULT_REVIEW_GATE
  if (!Number.isInteger(reviewGate.requiredApprovals) || reviewGate.requiredApprovals < 1) {
    throw new WorkflowAppValidationError("reviewGate.requiredApprovals must be positive")
  }
  const qualityGate = draft.qualityGate ?? DEFAULT_QUALITY_GATE
  positiveInteger(qualityGate.maxRunAgeMs, "qualityGate.maxRunAgeMs")
  positiveInteger(qualityGate.maxAvgLatencyMs, "qualityGate.maxAvgLatencyMs")
  if (qualityGate.enabled && !qualityGate.datasetId?.trim()) {
    throw new WorkflowAppValidationError("Enabled quality gates require an Eval dataset")
  }
  if (
    [
      qualityGate.thresholds.minPassAt1,
      qualityGate.thresholds.minPassHatK,
      qualityGate.thresholds.maxUngradedRatio,
    ].some((value) => value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1))
  ) {
    throw new WorkflowAppValidationError("Quality gate ratio thresholds must be between 0 and 1")
  }
  if (
    qualityGate.thresholds.maxTotalCostUsd !== undefined &&
    (!Number.isFinite(qualityGate.thresholds.maxTotalCostUsd) ||
      qualityGate.thresholds.maxTotalCostUsd <= 0)
  ) {
    throw new WorkflowAppValidationError("qualityGate.maxTotalCostUsd must be positive")
  }
  const annotationReply = draft.annotationReply ?? DEFAULT_ANNOTATION_REPLY
  if (
    !Number.isFinite(annotationReply.threshold) ||
    annotationReply.threshold < 0 ||
    annotationReply.threshold > 1
  ) {
    throw new WorkflowAppValidationError("annotationReply.threshold must be between 0 and 1")
  }
  if (
    annotationReply.enabled &&
    (!annotationReply.setId ||
      !annotationReply.embeddingProfileId ||
      !annotationReply.embeddingProvider ||
      !annotationReply.embeddingModel ||
      !annotationReply.vectorBackend)
  ) {
    throw new WorkflowAppValidationError(
      "Enabled annotation replies require a set, embedding profile, provider, model, and vector backend"
    )
  }
  if (
    draft.quota.dailyCostBudgetUsd !== undefined &&
    (!Number.isFinite(draft.quota.dailyCostBudgetUsd) || draft.quota.dailyCostBudgetUsd <= 0)
  ) {
    throw new WorkflowAppValidationError("quota.dailyCostBudgetUsd must be positive")
  }
  for (const [locale, content] of Object.entries(draft.localized)) {
    if (!content?.title.trim()) {
      throw new WorkflowAppValidationError(
        `${locale}.title is required when a locale is configured`
      )
    }
  }
  for (const [knowledgeBaseId, binding] of Object.entries(draft.knowledgeBindings)) {
    const generationIds = Array.isArray(binding) ? binding : [binding]
    if (
      !knowledgeBaseId.trim() ||
      generationIds.length === 0 ||
      generationIds.some((id) => !id.trim())
    ) {
      throw new WorkflowAppValidationError(
        "knowledgeBindings must contain non-empty Knowledge Base and revision ids"
      )
    }
  }
}

function mergeDraft(current: WorkflowAppDraft, patch: Partial<WorkflowAppDraft>): WorkflowAppDraft {
  return {
    ...current,
    ...clone(patch),
    theme: patch.theme ? { ...current.theme, ...patch.theme } : current.theme,
    localized: patch.localized ? { ...current.localized, ...patch.localized } : current.localized,
    access: patch.access ? { ...current.access, ...patch.access } : current.access,
    embed: patch.embed ? { ...current.embed, ...patch.embed } : current.embed,
    customDomain: Object.prototype.hasOwnProperty.call(patch, "customDomain")
      ? clone(patch.customDomain)
      : current.customDomain,
    resultSharing: patch.resultSharing
      ? { ...current.resultSharing, ...patch.resultSharing }
      : current.resultSharing,
    mcp: patch.mcp ? { ...current.mcp, ...patch.mcp } : current.mcp,
    quota: patch.quota ? { ...current.quota, ...patch.quota } : current.quota,
    contentPolicy: patch.contentPolicy
      ? { ...current.contentPolicy, ...patch.contentPolicy }
      : current.contentPolicy,
    legal: patch.legal ? { ...current.legal, ...patch.legal } : current.legal,
    reviewGate: patch.reviewGate
      ? { ...(current.reviewGate ?? DEFAULT_REVIEW_GATE), ...patch.reviewGate }
      : (current.reviewGate ?? clone(DEFAULT_REVIEW_GATE)),
    qualityGate: patch.qualityGate
      ? { ...(current.qualityGate ?? DEFAULT_QUALITY_GATE), ...patch.qualityGate }
      : (current.qualityGate ?? clone(DEFAULT_QUALITY_GATE)),
    annotationReply: patch.annotationReply
      ? { ...(current.annotationReply ?? DEFAULT_ANNOTATION_REPLY), ...patch.annotationReply }
      : (current.annotationReply ?? clone(DEFAULT_ANNOTATION_REPLY)),
    knowledgeBindings: patch.knowledgeBindings
      ? { ...current.knowledgeBindings, ...patch.knowledgeBindings }
      : current.knowledgeBindings,
  }
}

export async function createWorkflowApp(input: {
  accountId: string
  workflowId: string
  kind: WorkflowAppKind
  slug: string
  now?: number
  createdBy?: string
}): Promise<WorkflowApp> {
  if (!APP_SLUG.test(input.slug)) {
    throw new WorkflowAppValidationError(
      "App slug must contain lowercase letters, numbers, and single hyphens"
    )
  }
  const now = input.now ?? Date.now()
  const app: WorkflowApp = {
    id: `wfa_${crypto.randomUUID()}`,
    accountId: input.accountId,
    workflowId: input.workflowId,
    kind: input.kind,
    slug: input.slug,
    draft: defaultWorkflowAppDraft(input.kind),
    draftRevision: 1,
    publicationRevision: 0,
    createdAt: now,
    updatedAt: now,
    ...(input.createdBy ? { createdBy: input.createdBy, updatedBy: input.createdBy } : {}),
  }
  try {
    await getDb().workflowApps.add(app)
  } catch (error) {
    if ((error as { name?: string }).name === "ConstraintError") {
      throw new WorkflowAppConflictError(`Workflow app slug already exists: ${input.slug}`)
    }
    throw error
  }
  return app
}

export function getWorkflowApp(id: string): Promise<WorkflowApp | undefined> {
  return getDb().workflowApps.get(id)
}

export function getWorkflowAppBySlug(
  accountId: string,
  slug: string
): Promise<WorkflowApp | undefined> {
  return getDb().workflowApps.where("[accountId+slug]").equals([accountId, slug]).first()
}

export function getWorkflowAppRelease(id: string): Promise<WorkflowAppRelease | undefined> {
  return getDb().workflowAppReleases.get(id)
}

export async function updateWorkflowAppDraft(input: {
  appId: string
  accountId: string
  expectedRevision: number
  patch: Partial<WorkflowAppDraft>
  now?: number
  updatedBy?: string
}): Promise<WorkflowApp> {
  const db = getDb()
  return db.transaction("rw", db.workflowApps, async () => {
    const app = await db.workflowApps.get(input.appId)
    if (!app || app.accountId !== input.accountId) {
      throw new WorkflowAppValidationError("Workflow app was not found")
    }
    if (app.draftRevision !== input.expectedRevision) {
      throw new WorkflowAppConflictError(
        `Workflow app draft changed from revision ${input.expectedRevision} to ${app.draftRevision}`
      )
    }
    const draft = mergeDraft(app.draft, input.patch)
    validateWorkflowAppDraft(draft)
    const updated: WorkflowApp = {
      ...app,
      draft,
      draftRevision: app.draftRevision + 1,
      updatedAt: input.now ?? Date.now(),
      ...(input.updatedBy ? { updatedBy: input.updatedBy } : {}),
    }
    await db.workflowApps.put(updated)
    return updated
  })
}

export async function publishWorkflowApp(input: {
  appId: string
  accountId: string
  deploymentId: string
  versionId?: string
  now?: number
  createdBy?: string
  qualityGateOverride?: WorkflowQualityGateOverride
}): Promise<{ app: WorkflowApp; release: WorkflowAppRelease }> {
  const db = getDb()
  const [preliminaryApp, preliminaryDeployment] = await Promise.all([
    db.workflowApps.get(input.appId),
    db.workflowDeployments.get(input.deploymentId),
  ])
  if (!preliminaryApp || preliminaryApp.accountId !== input.accountId) {
    throw new WorkflowAppValidationError("Workflow app was not found")
  }
  if (
    !preliminaryDeployment ||
    preliminaryDeployment.accountId !== preliminaryApp.accountId ||
    preliminaryDeployment.workflowId !== preliminaryApp.workflowId
  ) {
    throw new WorkflowAppValidationError("Deployment does not belong to the workflow app")
  }
  const preliminaryVersion = await db.workflowVersions.get(
    input.versionId ?? preliminaryDeployment.versionId
  )
  if (
    !preliminaryVersion ||
    preliminaryVersion.accountId !== preliminaryApp.accountId ||
    preliminaryVersion.workflowId !== preliminaryApp.workflowId
  ) {
    throw new WorkflowAppValidationError("Version does not belong to the workflow app")
  }
  validateWorkflowAppDraft(preliminaryApp.draft)
  if (
    preliminaryApp.draft.customDomain &&
    preliminaryApp.draft.customDomain.verificationStatus !== "verified"
  ) {
    throw new WorkflowAppValidationError("Custom domain ownership must be verified before publish")
  }
  const approvedReview = await assertWorkflowReviewGate({
    accountId: input.accountId,
    workflowId: preliminaryApp.workflowId,
    versionId: preliminaryVersion.id,
    policy: preliminaryApp.draft.reviewGate ?? DEFAULT_REVIEW_GATE,
  })
  const qualityGateEvidence = await assertWorkflowDeploymentQuality({
    workflowId: preliminaryApp.workflowId,
    versionId: preliminaryVersion.id,
    policy: preliminaryApp.draft.qualityGate ?? DEFAULT_QUALITY_GATE,
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.qualityGateOverride ? { override: input.qualityGateOverride } : {}),
  })
  const dependencyLock = await createWorkflowDependencyLockForVersion(
    preliminaryVersion,
    preliminaryDeployment.environment
  )
  dependencyLock.plugins = await assertWorkflowPluginPublicationPreflight(preliminaryVersion)
  for (const [knowledgeBaseId, binding] of Object.entries(preliminaryApp.draft.knowledgeBindings)) {
    const generationIds = Array.isArray(binding) ? binding : [binding]
    await assertKnowledgeBaseRevisionBindings(knowledgeBaseId, generationIds)
    for (const key of Object.keys(dependencyLock.indexes)) {
      if (key.startsWith(`knowledge:${knowledgeBaseId}:`)) delete dependencyLock.indexes[key]
    }
    generationIds.forEach((generationId, index) => {
      dependencyLock.indexes[`knowledge:${knowledgeBaseId}:app:${index}`] = generationId
    })
  }
  const published = await db.transaction(
    "rw",
    db.workflowApps,
    db.workflowAppReleases,
    db.workflowVersions,
    db.workflowDeployments,
    db.workflowAnnotationSets,
    db.workflowAnnotationSetRevisions,
    db.plugins,
    async () => {
      const [app, deployment] = await Promise.all([
        db.workflowApps.get(input.appId),
        db.workflowDeployments.get(input.deploymentId),
      ])
      if (!app || app.accountId !== input.accountId) {
        throw new WorkflowAppValidationError("Workflow app was not found")
      }
      if (app.draftRevision !== preliminaryApp.draftRevision) {
        throw new WorkflowAppConflictError("Workflow app draft changed during publication")
      }
      if (
        !deployment ||
        deployment.accountId !== app.accountId ||
        deployment.workflowId !== app.workflowId
      ) {
        throw new WorkflowAppValidationError("Deployment does not belong to the workflow app")
      }
      const versionId = input.versionId ?? deployment.versionId
      const version = await db.workflowVersions.get(versionId)
      if (
        !version ||
        version.accountId !== app.accountId ||
        version.workflowId !== app.workflowId
      ) {
        throw new WorkflowAppValidationError("Version does not belong to the workflow app")
      }
      for (const binding of Object.values(dependencyLock.plugins ?? {})) {
        const plugin = await db.plugins.get(binding.pluginId)
        if (
          !plugin ||
          plugin.version !== binding.version ||
          workflowVersionDigest(plugin.manifest) !== binding.manifestDigest
        ) {
          throw new WorkflowAppConflictError(
            `Plugin ${binding.pluginId} changed during publication; run preflight again`
          )
        }
      }
      const publishDraft: WorkflowAppDraft = {
        ...app.draft,
        reviewGate: app.draft.reviewGate ?? clone(DEFAULT_REVIEW_GATE),
        qualityGate: app.draft.qualityGate ?? clone(DEFAULT_QUALITY_GATE),
        annotationReply: app.draft.annotationReply ?? clone(DEFAULT_ANNOTATION_REPLY),
      }
      validateWorkflowAppDraft(publishDraft)
      let annotationRevisionId: string | undefined
      if (publishDraft.annotationReply.enabled) {
        const annotationSet = await db.workflowAnnotationSets.get(
          publishDraft.annotationReply.setId!
        )
        const annotationRevision = annotationSet?.currentRevisionId
          ? await db.workflowAnnotationSetRevisions.get(annotationSet.currentRevisionId)
          : undefined
        if (
          !annotationSet ||
          annotationSet.accountId !== app.accountId ||
          annotationSet.appId !== app.id ||
          !annotationRevision ||
          !annotationRevision.validation.valid ||
          annotationRevision.accountId !== app.accountId ||
          annotationRevision.appId !== app.id ||
          annotationRevision.embeddingProfileId !==
            publishDraft.annotationReply.embeddingProfileId ||
          annotationRevision.embeddingProvider !== publishDraft.annotationReply.embeddingProvider ||
          annotationRevision.embeddingModel !== publishDraft.annotationReply.embeddingModel ||
          annotationRevision.vectorBackend !== publishDraft.annotationReply.vectorBackend
        ) {
          throw new WorkflowAppValidationError(
            "Annotation reply configuration has no matching validated published revision"
          )
        }
        annotationRevisionId = annotationRevision.id
      }
      const prior = await db.workflowAppReleases.where("appId").equals(app.id).sortBy("sequence")
      const sequence = (prior.at(-1)?.sequence ?? 0) + 1
      const now = input.now ?? Date.now()
      const release: WorkflowAppRelease = {
        id: `wfar_${app.id}_${sequence}`,
        appId: app.id,
        accountId: app.accountId,
        workflowId: app.workflowId,
        appKind: app.kind,
        sequence,
        appDraftRevision: app.draftRevision,
        versionId: version.id,
        versionDigest: version.digest,
        deploymentId: deployment.id,
        deploymentRevision: deployment.revision,
        workflowInterface: clone(version.interface),
        dependencyLock: clone(dependencyLock),
        snapshot: clone(publishDraft),
        ...(annotationRevisionId ? { annotationRevisionId } : {}),
        ...(qualityGateEvidence ? { qualityGateEvidence: clone(qualityGateEvidence) } : {}),
        createdAt: now,
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      }
      const published: WorkflowApp = {
        ...app,
        draft: publishDraft,
        currentReleaseId: release.id,
        publicationRevision: app.publicationRevision + 1,
        updatedAt: now,
        ...(input.createdBy ? { updatedBy: input.createdBy } : {}),
      }
      await db.workflowAppReleases.add(release)
      await db.workflowApps.put(published)
      return { app: published, release }
    }
  )
  if (approvedReview) await markWorkflowReviewPublished(approvedReview.id, input.now ?? Date.now())
  return published
}

export async function rollbackWorkflowApp(input: {
  appId: string
  accountId: string
  releaseId: string
  now?: number
  updatedBy?: string
}): Promise<WorkflowApp> {
  const db = getDb()
  return db.transaction("rw", db.workflowApps, db.workflowAppReleases, async () => {
    const [app, release] = await Promise.all([
      db.workflowApps.get(input.appId),
      db.workflowAppReleases.get(input.releaseId),
    ])
    if (!app || app.accountId !== input.accountId) {
      throw new WorkflowAppValidationError("Workflow app was not found")
    }
    if (!release || release.appId !== app.id || release.accountId !== app.accountId) {
      throw new WorkflowAppValidationError("Workflow app release was not found")
    }
    const updated: WorkflowApp = {
      ...app,
      currentReleaseId: release.id,
      publicationRevision: app.publicationRevision + 1,
      updatedAt: input.now ?? Date.now(),
      ...(input.updatedBy ? { updatedBy: input.updatedBy } : {}),
    }
    await db.workflowApps.put(updated)
    return updated
  })
}

export async function resolvePublishedWorkflowApp(
  accountId: string,
  slug: string
): Promise<ResolvedWorkflowAppRelease | undefined> {
  const db = getDb()
  const app = await db.workflowApps.where("[accountId+slug]").equals([accountId, slug]).first()
  if (!app?.currentReleaseId) return undefined
  return resolveWorkflowAppRelease(accountId, app.id, app.currentReleaseId)
}

export async function resolvePublishedWorkflowAppByDomain(
  accountId: string,
  hostname: string
): Promise<ResolvedWorkflowAppRelease | undefined> {
  const apps = await getDb().workflowApps.where("accountId").equals(accountId).toArray()
  for (const app of apps) {
    if (!app.currentReleaseId) continue
    const release = await getDb().workflowAppReleases.get(app.currentReleaseId)
    if (
      release?.snapshot.customDomain?.verificationStatus === "verified" &&
      release.snapshot.customDomain.hostname === hostname
    ) {
      return resolveWorkflowAppRelease(accountId, app.id, release.id)
    }
  }
  return undefined
}

/** Resolve the exact release pinned by an existing Chatflow conversation. */
export async function resolveWorkflowAppRelease(
  accountId: string,
  appId: string,
  releaseId: string
): Promise<ResolvedWorkflowAppRelease | undefined> {
  const db = getDb()
  const [app, release] = await Promise.all([
    db.workflowApps.get(appId),
    db.workflowAppReleases.get(releaseId),
  ])
  if (!app || app.accountId !== accountId) return undefined
  if (!release || release.appId !== app.id || release.accountId !== accountId) {
    throw new WorkflowAppValidationError("Workflow app points to an invalid release")
  }
  const version = await db.workflowVersions.get(release.versionId)
  if (
    !version ||
    version.accountId !== accountId ||
    version.workflowId !== release.workflowId ||
    version.digest !== release.versionDigest
  ) {
    throw new WorkflowAppValidationError("Workflow app release points to an invalid version")
  }
  return {
    app,
    release,
    version,
    binding: {
      versionId: release.versionId,
      deploymentId: release.deploymentId,
      deploymentRevision: release.deploymentRevision,
      entrypoint: "portal",
      caller: "anonymous",
      dependencyLock: clone(release.dependencyLock),
    },
  }
}
