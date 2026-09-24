import type { UIMessage } from "ai"
import type {
  RouterFusionRunSummary,
  RouterFusionTurnStamp,
  SendOptions,
} from "@cognia/agent-config-types"

export interface MessageRunMetadata {
  providerId?: string
  modelId?: string
  startedAt?: number
  completedAt?: number
  durationMs?: number
  finishReason?: string
  /**
   * The agent composition this turn ran under (ADR-0117 preset identity),
   * stamped at seal so the transcript keeps saying "Build" after the user
   * switches the session to another preset mid-conversation. `icon` is a
   * Lucide export name (`"Hammer"`), resolved via `getLucideExport`.
   */
  agent?: {
    presetId?: string
    name?: string
    icon?: string
  }
  /**
   * Routing explainability for the turn that produced this message — the
   * plan's own record, not a re-derivation: what was asked for, what the
   * strategy chose, and why. Absent when the turn never went through
   * `planRoute` (e.g. an external runtime that resolves its own model).
   */
  routing?: {
    mode: "auto" | "alias" | "manual"
    alias?: string
    tier?: string
    score?: number
    strategy: string
    reasonCodes: string[]
    judgeUsed?: boolean
    candidateCount: number
  }
  /**
   * Router + Fusion (ADR-0188) for a turn that went through it: how the run was
   * routed, what the ledger booked when the turn ended, and whether a fault sent
   * the turn down the original path unledgered. Absent while the switch is off.
   */
  routerFusion?: RouterFusionRunMetadata
  /**
   * Who answered a turn the user addressed with a leading `@handle`
   * (`lib/chat/turn-route/`). Stamped at seal, like `agent`, so the bubble
   * keeps naming Codex — or the Squad member — after the conversation goes back
   * to its own runtime. Absent on every unaddressed turn.
   */
  route?: MessageRunRouteStamp
}

/** The route a turn ran on, as the transcript remembers it. */
export interface MessageRunRouteStamp {
  /** The handle the user typed, without the `@`. */
  handle: string
  /** Display name: the runtime, or the Squad member the turn ran as. */
  label: string
  /** Which lane actually answered. */
  runtimeKind: "builtin" | "external" | "host"
  /** Brand glyph id for the answering engine (a preset id or a provider id). */
  brandId?: string
  /** Set when the turn ran as a Squad member. */
  teammateId?: string
  squadId?: string
}

/** Plain-data copy of a Router + Fusion turn for the transcript and the run card. */
export interface RouterFusionRunMetadata {
  /** How the turn was routed; absent when a fault bypassed routing before it stamped. */
  route?: RouterFusionTurnStamp
  /** The sealed run; absent when the turn never got a run (bypass) or the seal failed. */
  outcome?: {
    status: string
    spentMicrousd: number
    overspendMicrousd: number
    modelCalls: number
    /** `actual` | `estimated` | `pending` — a pending cost has an unanswered call. */
    costStatus: string
    frozen: boolean
    refusalCode: string | null
  }
  /** The turn ran on the original path, not ledgered, because Router + Fusion faulted. */
  bypass?: { code: string; justTripped: boolean }
  /**
   * A verified cascade or panel run (B3): its roles, phase timeline, candidate
   * and judge counts and what it cost. Written with the run's answer message.
   */
  fusion?: RouterFusionRunSummary
}

/** The subset of the sealed run summary the transcript keeps. */
export interface RouterFusionRunOutcomeInput {
  status: string
  spentMicrousd: number
  overspendMicrousd: number
  modelCalls: number
  costStatus: string
  frozen: boolean
  refusalCode: string | null
  bypass: { code: string; justTripped: boolean } | null
}

export interface CompletedRunMetadataInput {
  providerId?: string
  modelId?: string
  startedAt?: number
  completedAt: number
  reportedDurationMs?: number
  finishReason?: string
  routing?: MessageRunMetadata["routing"]
  routerFusion?: RouterFusionRunMetadata
  agent?: MessageRunMetadata["agent"]
  route?: MessageRunRouteStamp
}

/**
 * Project a turn's Router + Fusion stamp and sealed run into message metadata.
 * `undefined` for a turn that never touched Router + Fusion, so the off path
 * writes exactly the metadata it always did.
 */
export function buildRouterFusionRunMetadata(
  options: Pick<SendOptions, "routerFusion" | "routerFusionBypass"> | undefined,
  outcome: RouterFusionRunOutcomeInput | null
): RouterFusionRunMetadata | undefined {
  const route = options?.routerFusion
  const bypass = outcome?.bypass ?? options?.routerFusionBypass
  if (!route && !outcome && !bypass) return undefined
  return {
    ...(route ? { route: { ...route } } : {}),
    ...(outcome
      ? {
          outcome: {
            status: outcome.status,
            spentMicrousd: outcome.spentMicrousd,
            overspendMicrousd: outcome.overspendMicrousd,
            modelCalls: outcome.modelCalls,
            costStatus: outcome.costStatus,
            frozen: outcome.frozen,
            refusalCode: outcome.refusalCode,
          },
        }
      : {}),
    ...(bypass ? { bypass: { code: bypass.code, justTripped: bypass.justTripped } } : {}),
  }
}

/**
 * Project the SendOptions routing record into the message-metadata shape.
 *
 * Reads the PLAN, never re-derives: `mode` is what the caller requested,
 * `strategy`/`reasonCodes`/`candidateCount` come straight off the plan, and
 * `tier`/`score` prefer the plan's difficulty outcome (post-judge) over the
 * send option's earlier stamp. `undefined` when no plan exists — a manual
 * provider:model send carries no routing story to tell.
 */
export function buildRoutingRunMetadata(
  options: Pick<SendOptions, "routingPlan" | "autoRouting" | "aliasResolution">
): MessageRunMetadata["routing"] | undefined {
  const plan = options.routingPlan
  // A plan without `requested` is malformed, not absent — but this helper runs
  // inside the turn-seal path, where a metadata bug must never take the event
  // handler down with it.
  if (!plan?.requested) return undefined
  const mode = plan.requested.kind
  const difficulty = plan.difficulty
  const tier = difficulty?.tier ?? options.autoRouting?.tier
  const score = difficulty?.score ?? options.autoRouting?.score
  return {
    mode,
    strategy: String(plan.strategy),
    reasonCodes: [...plan.reasonCodes],
    candidateCount: plan.orderedCandidates.length,
    ...(difficulty?.judgeUsed !== undefined ? { judgeUsed: difficulty.judgeUsed } : {}),
    ...(tier !== undefined ? { tier } : {}),
    ...(score !== undefined ? { score } : {}),
    ...(mode !== "manual" && options.aliasResolution?.alias
      ? { alias: options.aliasResolution.alias }
      : {}),
  }
}

/** Build an honest completion snapshot without consulting mutable session routing state. */
export function buildCompletedRunMetadata({
  providerId,
  modelId,
  startedAt,
  completedAt,
  reportedDurationMs,
  finishReason,
  routing,
  routerFusion,
  agent,
  route,
}: CompletedRunMetadataInput): MessageRunMetadata {
  return {
    providerId,
    modelId,
    startedAt,
    completedAt,
    durationMs:
      typeof reportedDurationMs === "number" && Number.isFinite(reportedDurationMs)
        ? reportedDurationMs
        : startedAt === undefined
          ? undefined
          : Math.max(0, completedAt - startedAt),
    finishReason,
    ...(routing ? { routing } : {}),
    ...(routerFusion ? { routerFusion } : {}),
    ...(agent ? { agent } : {}),
    ...(route ? { route: { ...route } } : {}),
  }
}

export function runMetadataOf(message: UIMessage): MessageRunMetadata | undefined {
  const run = (message.metadata as { run?: unknown } | undefined)?.run
  return run && typeof run === "object" ? (run as MessageRunMetadata) : undefined
}

export function attachRunMetadataToLastAssistant(
  messages: UIMessage[],
  run: MessageRunMetadata
): UIMessage[] {
  const entries = Object.entries(run).filter(([, value]) => value !== undefined)
  if (entries.length === 0) return messages
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== "assistant") continue
    const metadata = (message.metadata as Record<string, unknown> | undefined) ?? {}
    const existingRun = runMetadataOf(message)
    const next = messages.slice()
    next[index] = {
      ...message,
      metadata: { ...metadata, run: { ...(existingRun ?? {}), ...Object.fromEntries(entries) } },
    }
    return next
  }
  return messages
}

/**
 * Attach a turn's token accounting to the newest assistant message.
 *
 * The built-in sidecar lane gets `metadata.usage` from the SDK `result` event
 * (`lib/claude/adapter.ts`); the external-agent lane had no equivalent, so its
 * turns reached the transcript with no usage at all and every consumer — the
 * context indicator, the session cost, `/context` — read them as a session that
 * had spent nothing. Merges rather than replaces, so a partially-populated
 * usage object already on the message keeps its fields.
 */
export function attachUsageToLastAssistant(
  messages: UIMessage[],
  usage: Record<string, unknown>
): UIMessage[] {
  const entries = Object.entries(usage).filter(([, value]) => value !== undefined)
  if (entries.length === 0) return messages
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== "assistant") continue
    const metadata = (message.metadata as Record<string, unknown> | undefined) ?? {}
    const existing = (metadata.usage as Record<string, unknown> | undefined) ?? {}
    const next = messages.slice()
    next[index] = {
      ...message,
      metadata: { ...metadata, usage: { ...existing, ...Object.fromEntries(entries) } },
    }
    return next
  }
  return messages
}
