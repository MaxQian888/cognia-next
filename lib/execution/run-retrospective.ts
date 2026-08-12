import type { ResourceRefV1 } from "@cognia/agent-config-types/governance"
import { hasNoLeakingPiiDeep, redactText } from "@cognia/redact"

import {
  getRunRetrospectiveBundleByRun,
  putRunRetrospectiveBundle,
} from "@/lib/db/run-retrospectives"
import { getExecutionRun, listVisibleExecutionRunEvents } from "@/lib/db/execution-runs"
import { sha256Hex } from "@/lib/share/hash"
import type { ExecutionRun, RunEvent } from "@/types/execution/run"
import {
  RUN_RETROSPECTIVE_ANALYSIS_VERSION,
  type RunLearningTargetKind,
  type RunRetrospectiveBundle,
  type RunRetrospectiveTimelineItem,
} from "@/types/execution/retrospective"

const MAX_TIMELINE_ITEMS = 20
const MAX_PROPOSALS = 8
const MAX_TITLE_CHARS = 160
const MAX_BODY_BYTES = 8 * 1024
const SAFE_EVENT_PAYLOAD_KEYS = new Set([
  "title",
  "label",
  "status",
  "summary",
  "error",
  "toolName",
  "stepId",
  "sourceRunId",
  "resourceRef",
  "resourceRefs",
])
const TARGET_KINDS = new Set<RunLearningTargetKind>([
  "team-config",
  "project-environment",
  "memory-candidate",
  "skill-draft",
  "observation",
])

export interface RunRetrospectiveModelResult {
  issueTimeline: Array<{ at: number; summary: string; eventRef?: ResourceRefV1 }>
  proposals: Array<{
    targetKind: RunLearningTargetKind
    targetId?: string
    title: string
    before?: string
    after: string
    evidenceRefs?: ResourceRefV1[]
  }>
}

export interface SafeRunRetrospectiveAdapterContext {
  summary?: string
  resourceRefs?: ResourceRefV1[]
}

export interface RunRetrospectiveServiceOptions {
  runModel(prompt: string): Promise<RunRetrospectiveModelResult>
  buildAdapterContext?: (
    run: ExecutionRun
  ) => Promise<SafeRunRetrospectiveAdapterContext | undefined>
  now?: () => number
  analysisVersion?: number
}

function id(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`
}

function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactText(value).redacted
  if (Array.isArray(value)) return value.map(redactDeep)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        redactDeep(nested),
      ])
    )
  }
  return value
}

function validResourceRef(value: unknown): value is ResourceRefV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const ref = value as Record<string, unknown>
  return (
    typeof ref.namespace === "string" &&
    ref.namespace.trim().length > 0 &&
    typeof ref.type === "string" &&
    ref.type.trim().length > 0 &&
    typeof ref.id === "string" &&
    ref.id.trim().length > 0 &&
    !/^https?:\/\//i.test(ref.id)
  )
}

function safeEvent(event: RunEvent): Record<string, unknown> {
  const payload = Object.fromEntries(
    Object.entries(event.payload)
      .filter(([key]) => SAFE_EVENT_PAYLOAD_KEYS.has(key))
      .map(([key, value]) => [key, redactDeep(value)])
  )
  return {
    ts: event.ts,
    type: event.type,
    visibility: event.visibility,
    payload,
    ref: { namespace: "cognia", type: "run-event", id: event.id },
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function safeText(value: unknown, label: string, maxBytes = MAX_BODY_BYTES): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  const redacted = redactText(value.trim()).redacted
  if (!redacted) throw new Error(`${label} is required`)
  if (byteLength(redacted) > maxBytes) throw new Error(`${label} must be at most ${maxBytes} bytes`)
  if (!hasNoLeakingPiiDeep(redacted)) throw new Error(`${label} rejected by the PII gate`)
  return redacted
}

function normalizeResult(
  runId: string,
  result: RunRetrospectiveModelResult,
  retrospectiveId: string,
  now: number
): Pick<RunRetrospectiveBundle, "proposals"> & { issueTimeline: RunRetrospectiveTimelineItem[] } {
  if (!Array.isArray(result.issueTimeline) || result.issueTimeline.length > MAX_TIMELINE_ITEMS) {
    throw new Error(`Run retrospective may contain at most ${MAX_TIMELINE_ITEMS} timeline items`)
  }
  if (!Array.isArray(result.proposals) || result.proposals.length > MAX_PROPOSALS) {
    throw new Error(`Run retrospective may contain at most ${MAX_PROPOSALS} proposals`)
  }
  const issueTimeline = result.issueTimeline.map((item) => {
    if (!Number.isFinite(item.at) || item.at < 0) throw new Error("Timeline timestamp is invalid")
    if (item.eventRef && !validResourceRef(item.eventRef)) {
      throw new Error("Timeline event reference is invalid")
    }
    return {
      at: item.at,
      summary: safeText(item.summary, "Timeline summary", 512),
      ...(item.eventRef ? { eventRef: item.eventRef } : {}),
    }
  })
  const proposals = result.proposals.map((proposal) => {
    if (!TARGET_KINDS.has(proposal.targetKind)) throw new Error("Unknown learning target")
    if (proposal.title.length > MAX_TITLE_CHARS) {
      throw new Error(`Proposal title must be at most ${MAX_TITLE_CHARS} characters`)
    }
    const evidenceRefs = proposal.evidenceRefs ?? [
      { namespace: "cognia", type: "execution-run", id: runId },
    ]
    if (!evidenceRefs.every(validResourceRef))
      throw new Error("Proposal evidence reference is invalid")
    return {
      id: id("run-learning"),
      retrospectiveId,
      runId,
      targetKind: proposal.targetKind,
      ...(proposal.targetId ? { targetId: proposal.targetId } : {}),
      title: safeText(proposal.title, "Proposal title", MAX_TITLE_CHARS * 4),
      ...(proposal.before !== undefined
        ? { before: safeText(proposal.before, "Proposal before") }
        : {}),
      after: safeText(proposal.after, "Proposal after"),
      status: "pending" as const,
      evidenceRefs,
      createdAt: now,
      updatedAt: now,
    }
  })
  return { issueTimeline, proposals }
}

function buildPrompt(
  run: ExecutionRun,
  events: RunEvent[],
  adapterContext?: SafeRunRetrospectiveAdapterContext
): string {
  const safeAdapter = adapterContext
    ? {
        ...(adapterContext.summary
          ? { summary: redactText(adapterContext.summary).redacted.slice(0, 8 * 1024) }
          : {}),
        resourceRefs: (adapterContext.resourceRefs ?? []).filter(validResourceRef),
      }
    : undefined
  const input = {
    run: {
      id: run.id,
      kind: run.kind,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
    },
    events: events.map(safeEvent),
    ...(safeAdapter ? { adapterContext: safeAdapter } : {}),
  }
  if (!hasNoLeakingPiiDeep(input)) throw new Error("Run retrospective input rejected by PII gate")
  return [
    "Analyze this terminal Cognia ExecutionRun from safe projections only.",
    "Do not infer hidden reasoning. Return approval-required proposals; do not claim they were applied.",
    JSON.stringify(input),
  ].join("\n\n")
}

export function createRunRetrospectiveService(options: RunRetrospectiveServiceOptions) {
  const now = options.now ?? Date.now
  const analysisVersion = options.analysisVersion ?? RUN_RETROSPECTIVE_ANALYSIS_VERSION

  return {
    async generate(runId: string): Promise<RunRetrospectiveBundle> {
      const existing = await getRunRetrospectiveBundleByRun(runId, analysisVersion)
      if (existing) return existing
      const run = await getExecutionRun(runId)
      if (!run) throw new Error(`Unknown ExecutionRun: ${runId}`)
      if (!(["completed", "failed", "cancelled"] as const).includes(run.status as never)) {
        throw new Error("Run retrospective requires a terminal ExecutionRun")
      }
      const [events, adapterContext] = await Promise.all([
        listVisibleExecutionRunEvents(runId),
        options.buildAdapterContext?.(run),
      ])
      const result = await options.runModel(buildPrompt(run, events, adapterContext))
      const createdAt = now()
      const retrospectiveId = id("run-retrospective")
      const normalized = normalizeResult(runId, result, retrospectiveId, createdAt)
      const contentHash = await sha256Hex(
        JSON.stringify({ issueTimeline: normalized.issueTimeline, proposals: normalized.proposals })
      )
      return putRunRetrospectiveBundle({
        retrospective: {
          id: retrospectiveId,
          runId,
          runKey: `${runId}:${analysisVersion}`,
          analysisVersion,
          status: normalized.proposals.length > 0 ? "pending_review" : "resolved",
          issueTimeline: normalized.issueTimeline,
          contentHash,
          createdAt,
          updatedAt: createdAt,
        },
        proposals: normalized.proposals,
      })
    },
  }
}

export async function generateConfiguredRunRetrospective(
  runId: string,
  options?: {
    adapterContext?: SafeRunRetrospectiveAdapterContext
    defaultTargetIds?: Partial<Record<RunLearningTargetKind, string>>
  }
): Promise<RunRetrospectiveBundle> {
  const [{ buildUtilityLlmClient }, { useSettingsStore }, { extractJson }] = await Promise.all([
    import("@/lib/ai/generation/utility-client"),
    import("@/stores/settings"),
    import("@/lib/twin/distill/llm"),
  ])
  const client = buildUtilityLlmClient({
    session: null,
    appSettings: useSettingsStore.getState().settings,
    featureId: "run-retrospective",
  })
  if (!client) throw new Error("A utility model is required for run retrospective analysis")
  return createRunRetrospectiveService({
    runModel: async (prompt) => {
      const response = await client.complete(prompt, {
        system:
          "Return JSON only: {issueTimeline:[{at,summary,eventRef?}],proposals:[{targetKind,targetId?,title,before?,after,evidenceRefs?}]}. " +
          "Allowed targetKind: team-config, project-environment, memory-candidate, skill-draft, observation.",
        temperature: 0.1,
        maxTokens: 2000,
      })
      const result = extractJson<RunRetrospectiveModelResult>(response)
      return {
        ...result,
        proposals: result.proposals.map((proposal) => ({
          ...proposal,
          targetId: proposal.targetId ?? options?.defaultTargetIds?.[proposal.targetKind],
        })),
      }
    },
    buildAdapterContext: options?.adapterContext ? async () => options.adapterContext : undefined,
  }).generate(runId)
}

export type RunRetrospectiveService = ReturnType<typeof createRunRetrospectiveService>
