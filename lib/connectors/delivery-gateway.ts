import { hasNoLeakingPiiDeep } from "@cognia/redact"
import type { OutboundJobAuthorization } from "@cognia/plugin-contract/lib/db/connector-types"
import { appendAudit, type AuditEntryInput } from "./audit"
import { enqueueOutbound, enqueueOutboundMany, type EnqueueInput } from "@/lib/db/outbound-jobs"
import { createDraft, type CreateDraftInput } from "@/lib/db/connector-drafts"
import type { ConnectorDraftRow, OutboundJobRow, OutboundJobSource } from "@/lib/db/connector-types"
import { stableJson } from "@/lib/account-sync/data/stable-json"
import {
  planDelivery,
  planUnplannedStream,
  type DeliveryDecision,
  type DeliveryDenyReason,
  type DeliveryPlanInput,
  type DeliveryReceipt,
  type InThreadAuthorization,
  type OutboundAuthorization,
  type UnplannedStreamDecision,
} from "@/lib/policy/action-review/plan-delivery"
import { personTarget, type OutboundTarget } from "@/lib/policy/action-review/outbound-targets"
import type {
  ForwardMessageInput,
  OutboundRequest,
  OutboundResult,
  PlatformAdapter,
  UrgentChannel,
} from "@/types/connectors"
import { buildConversationKey, parseConversationKey } from "@/types/connectors/event"
import type { PlatformKind } from "@/types/connectors/platform-kind"

export type OutboundJobInfo = OutboundJobRow
export type { OutboundAuthorization } from "@/lib/policy/action-review/plan-delivery"

const AUTOMATED_SOURCES = new Set<EnqueueInput["source"]>(["ai-run", "workflow", "skill", "plugin"])
const AUDIT_WRITE_CONCURRENCY = 16

export class ConnectorDeliveryPiiError extends Error {
  readonly code = "connector_delivery_pii_rejected"

  constructor(readonly source: EnqueueInput["source"]) {
    super(`Connector delivery from '${source}' was rejected by the fail-closed PII gate`)
    this.name = "ConnectorDeliveryPiiError"
  }
}

/** The outbound policy refused a delivery (ADR-0239). Nothing was persisted. */
export class ConnectorDeliveryDeniedError extends Error {
  readonly code = "connector_delivery_denied"

  constructor(
    readonly source: EnqueueInput["source"],
    readonly reason: DeliveryDenyReason
  ) {
    super(`Connector delivery from '${source}' was refused: ${DENY_REASON_TEXT[reason]}`)
    this.name = "ConnectorDeliveryDeniedError"
  }
}

const DENY_REASON_TEXT: Record<DeliveryDenyReason, string> = {
  fenced: "a person refused this recipient for the current request",
  "conversation-mismatch": "it named a conversation other than the one it answers",
  unapproved:
    "nothing authorized this recipient, and a delivery sent at once cannot wait for a person; queue it (ctx.connectors.enqueueSend) so it can be approved",
}

/**
 * The outbound policy held a delivery as a draft for a person to approve
 * (ADR-0239). Thrown only where the caller's contract has no way to say
 * "drafted", such as a plugin's `ctx.connectors.enqueueSend`.
 */
export class ConnectorDeliveryHeldError extends Error {
  readonly code = "connector_delivery_held"

  constructor(readonly draftId: string) {
    super("Connector delivery held as a draft: a person approves it before it is sent")
    this.name = "ConnectorDeliveryHeldError"
  }
}

type HumanSource = "manual" | "draft-approved"
type AutomatedSource = Exclude<OutboundJobSource, HumanSource>

/** What a caller hands the gateway. `authorizedBy` is the gateway's to write. */
type GovernedBase = Omit<EnqueueInput, "source" | "authorizedBy">

/**
 * One governed delivery. A person's own send (`manual`, `draft-approved`)
 * needs no authorization; every automated source names what authorizes it
 * (ADR-0239, `lib/policy/action-review/plan-delivery.ts`).
 */
export type GovernedEnqueueInput =
  | (GovernedBase & { source: HumanSource; authorization?: OutboundAuthorization })
  | (GovernedBase & { source: AutomatedSource; authorization: OutboundAuthorization })

/**
 * A delivery that is either queued or refused, never drafted: a person's own
 * send, a reply or notice into the conversation it answers, or a job the
 * outbound runner moves to a sibling bot of the same chat.
 */
export type InThreadEnqueueInput =
  | (GovernedBase & { source: HumanSource; authorization?: undefined })
  | (GovernedBase & { source: OutboundJobSource; authorization: InThreadAuthorization })

/**
 * A delivery that goes out at once instead of through the queue: a plugin's
 * deprecated direct send, or a forward of messages already sent. It is
 * planned like any other (`immediate`), and refused where another would be
 * drafted, since there is no draft to hold it in.
 */
export interface ImmediateDeliveryInput {
  adapterId: string
  /** The conversation it reaches; absent when the request names only a platform reference. */
  conversationKey?: string
  /**
   * The people it reaches, when that is not the conversation: an urgent push
   * (see {@link DeliveryPlanInput.recipients}).
   */
  recipients?: readonly OutboundTarget[]
  /** What it sends, for the PII gate. Absent for a forward or an urgent push, which send nothing new. */
  segments?: OutboundRequest["segments"]
  idempotencyKey?: string
  /**
   * Who sends it. Planned by `authorization` whatever the source: an SLA
   * escalation's urgent push keeps the `manual` source of its notice.
   */
  source: OutboundJobSource
  authorization: OutboundAuthorization
  /** The audit row the send leaves. */
  auditKind: "delivery.legacy_direct" | "delivery.forward_direct" | "delivery.urgent_direct"
  auditFields?: Record<string, unknown>
}

/**
 * An urgent push (加急): the platform re-notifies `userIds` about a message
 * already sent. Planned as an immediate delivery to those people, every one
 * of whom must be authorized.
 */
export interface GovernedUrgentInput {
  adapterId: string
  messageId: string
  userIds: readonly string[]
  via?: UrgentChannel
  /** The conversation the message is in, when the caller knows it: its configured lists count. */
  conversationKey?: string
  source: OutboundJobSource
  authorization: OutboundAuthorization
  auditFields?: Record<string, unknown>
}

/** The result a refused immediate delivery returns. */
export const CONNECTOR_DELIVERY_DENIED_CODE = "connector_delivery_denied"

/** Queued for the outbound runner, or held as a draft for a person to approve. */
export type EnqueueGovernedResult =
  { kind: "queued"; job: OutboundJobRow } | { kind: "drafted"; draft: ConnectorDraftRow }

/** What a withheld delivery's audit row names. */
interface WithheldSubject {
  adapterId: string
  conversationKey: string
  idempotencyKey?: string
  source: OutboundJobSource
}

export interface ConnectorDeliveryGatewayDependencies {
  persistOne(input: EnqueueInput): Promise<OutboundJobRow>
  persistMany(inputs: readonly EnqueueInput[]): Promise<OutboundJobRow[]>
  getAdapter(adapterId: string): PlatformAdapter | undefined | Promise<PlatformAdapter | undefined>
  piiGate(value: unknown): boolean
  appendAudit(entry: AuditEntryInput): Promise<unknown>
  planDelivery(input: DeliveryPlanInput): Promise<DeliveryDecision>
  createDraft(input: CreateDraftInput): Promise<ConnectorDraftRow>
  recordReceipt(receipt: DeliveryReceipt): Promise<void>
  /** Whether a stream no plan covers may run, and its shadow record (`planUnplannedStream`). */
  planStream(input: {
    adapterId: string
    ownerRef: string
    source: OutboundJobSource
  }): Promise<UnplannedStreamDecision>
  /** The clock that groups a stream's frames. */
  now(): number
  /** The adapter's own forward (`bus.forwardOutbound`). */
  forward(adapterId: string, input: ForwardMessageInput): Promise<OutboundResult>
  /** The adapter's own urgent push (`bus.sendUrgentOutbound`). */
  sendUrgent(
    adapterId: string,
    messageId: string,
    userIds: string[],
    via?: UrgentChannel
  ): Promise<OutboundResult>
}

async function recordDeliveryReceipt(receipt: DeliveryReceipt): Promise<void> {
  const { projectActionReviewSettled } = await import("@/lib/policy/action-review/projection")
  await projectActionReviewSettled(receipt.request, receipt.decision)
}

const defaultDependencies: ConnectorDeliveryGatewayDependencies = {
  persistOne: enqueueOutbound,
  persistMany: enqueueOutboundMany,
  // Keep the bus behind the diagnostic-only path. A static import here makes
  // every ordinary enqueue caller load the complete connector runtime graph
  // and creates a delivery-gateway ↔ outbound-runner cycle.
  getAdapter: async (adapterId) => {
    const { getBus } = await import("./bus")
    return getBus().getAdapter(adapterId)
  },
  piiGate: hasNoLeakingPiiDeep,
  appendAudit,
  planDelivery: (input) => planDelivery(input),
  createDraft,
  recordReceipt: recordDeliveryReceipt,
  planStream: (input) => planUnplannedStream(input),
  now: () => Date.now(),
  forward: async (adapterId, input) => {
    const { getBus } = await import("./bus")
    return getBus().forwardOutbound(adapterId, input)
  },
  sendUrgent: async (adapterId, messageId, userIds, via) => {
    const { getBus } = await import("./bus")
    return getBus().sendUrgentOutbound(adapterId, messageId, userIds, via)
  },
}

/**
 * The conversation a forward reaches. `target` is a conversation key or a
 * bare platform chat id, the shapes the adapters accept. A key of another
 * bot, or a bare id when the adapter's platform is unknown, names none.
 */
export function forwardConversationKey(
  adapterId: string,
  platform: PlatformKind | undefined,
  target: string
): string | undefined {
  const trimmed = target.trim()
  if (!trimmed) return undefined
  if (trimmed.includes(":")) {
    try {
      const parsed = parseConversationKey(trimmed)
      return parsed.adapterId === adapterId && parsed.remoteChatId ? trimmed : undefined
    } catch {
      return undefined
    }
  }
  return platform ? buildConversationKey(platform, adapterId, trimmed) : undefined
}

/** Frames to one reference this close together are one stream, recorded once. */
export const UNPLANNED_STREAM_IDLE_MS = 60_000
/** How many streams the gateway remembers at once to group their frames. */
const TRACKED_STREAM_LIMIT = 256

/** One frame of a stream no plan covers (a plugin's `streamReply`). */
export interface UnplannedStreamInput {
  adapterId: string
  /** The sender's own platform reference the frame goes to: frames to the same one are one stream. */
  conversationRef: unknown
  source: AutomatedSource
  /** Who sends it, as an unattended delivery's owner: `plugin:<id>`. */
  ownerRef: string
  auditFields?: Record<string, unknown>
}

/** A forward of messages already sent, by an automated sender. */
export interface GovernedForwardInput {
  adapterId: string
  forward: ForwardMessageInput
  source: AutomatedSource
  authorization: OutboundAuthorization
  auditFields?: Record<string, unknown>
}

function toPlanInput(input: GovernedEnqueueInput): DeliveryPlanInput {
  return {
    adapterId: input.adapterId,
    conversationKey: input.conversationKey,
    source: input.source,
    ...(input.authorization ? { authorization: input.authorization } : {}),
  }
}

function toPersisted(
  input: GovernedEnqueueInput,
  authorizedBy: OutboundJobAuthorization | undefined
): EnqueueInput {
  const { authorization: _authorization, ...rest } = input
  return { ...rest, ...(authorizedBy ? { authorizedBy } : {}) }
}

/**
 * The single governed entry point for ordinary connector delivery.
 * Persistence stays in `lib/db/outbound-jobs`; policy, provenance and the
 * explicit diagnostic waiver live here so business callers cannot silently
 * bypass one while retaining the others.
 *
 * Every delivery is planned by the outbound policy first (ADR-0239,
 * `planDelivery`): under enforcement it is queued with what authorized it
 * (`authorizedBy`), held as a draft for a person to approve, or refused with
 * {@link ConnectorDeliveryDeniedError}. A queued automated delivery then
 * passes the PII gate; a draft does not need to, because a person reads it
 * before it is sent.
 */
export class ConnectorDeliveryGateway {
  private readonly dependencies: ConnectorDeliveryGatewayDependencies
  /** When each recent stream sent its last frame, by sender, bot and reference. */
  private readonly streams = new Map<string, number>()

  constructor(dependencies: Partial<ConnectorDeliveryGatewayDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencies }
  }

  /**
   * Queue a delivery that is never drafted (see {@link InThreadEnqueueInput}).
   * Throws {@link ConnectorDeliveryDeniedError} when the policy refuses it.
   */
  async enqueue(input: InThreadEnqueueInput): Promise<OutboundJobInfo> {
    const [result] = await this.deliver([input as GovernedEnqueueInput])
    // `planDelivery` only queues or refuses these; a draft here is a bug.
    if (result.kind !== "queued") {
      throw new Error("connector delivery gateway: an in-thread delivery was held as a draft")
    }
    return result.job
  }

  /**
   * Queue an automated delivery the policy may hold as a draft for a person
   * to approve. Throws {@link ConnectorDeliveryDeniedError} when it refuses it.
   */
  async enqueueAuthorized(input: GovernedEnqueueInput): Promise<EnqueueGovernedResult> {
    const [result] = await this.deliver([input])
    return result
  }

  /**
   * Batch variant: one persistence transaction and one wake for what is
   * queued. One refused delivery refuses the batch, so nothing a person
   * refused goes out alongside the rest.
   */
  async enqueueMany(inputs: readonly GovernedEnqueueInput[]): Promise<EnqueueGovernedResult[]> {
    return this.deliver(inputs)
  }

  /**
   * Send one frame of a stream (`streamReply`), which no plan covers: a
   * stream names no conversation the host can check, and sends one frame per
   * update, so it can be neither planned nor drafted. Under enforcement it
   * may not: `stream` is not called, the result is `false` ("no streaming"),
   * and the caller falls back to a governed send. In shadow mode it streams,
   * and the first frame of each stream records a receipt saying enforcement
   * would not have let it, plus a `delivery.stream_unplanned` audit row.
   * Frames to the same reference less than {@link UNPLANNED_STREAM_IDLE_MS}
   * apart are one stream. A planning failure does not stream.
   */
  async streamUnplanned(
    input: UnplannedStreamInput,
    stream: () => Promise<boolean>
  ): Promise<boolean> {
    let decision: UnplannedStreamDecision
    try {
      decision = await this.dependencies.planStream({
        adapterId: input.adapterId,
        ownerRef: input.ownerRef,
        source: input.source,
      })
    } catch {
      return false
    }
    if (!decision.stream) return false
    if (decision.receipt && this.startsStream(input)) {
      await this.recordReceipt(decision.receipt)
      await Promise.resolve(
        this.dependencies.appendAudit({
          adapterId: input.adapterId,
          kind: "delivery.stream_unplanned",
          at: this.dependencies.now(),
          fields: {
            ...input.auditFields,
            source: input.source,
            governed: false,
            receiptId: decision.receipt.request.requestId,
          },
        })
      ).catch(() => undefined)
    }
    return stream()
  }

  /** Whether this frame starts a stream, rather than continuing a recent one. */
  private startsStream(input: UnplannedStreamInput): boolean {
    const now = this.dependencies.now()
    let key: string
    try {
      key = `${input.ownerRef}\u0000${input.adapterId}\u0000${stableJson(input.conversationRef)}`
    } catch {
      // A reference that cannot be serialized is never grouped.
      return true
    }
    const last = this.streams.get(key)
    // Re-inserted so the map stays ordered by last frame.
    this.streams.delete(key)
    this.streams.set(key, now)
    if (this.streams.size > TRACKED_STREAM_LIMIT) {
      const oldest = this.streams.keys().next().value
      if (oldest !== undefined) this.streams.delete(oldest)
    }
    return last === undefined || now - last >= UNPLANNED_STREAM_IDLE_MS
  }

  /**
   * Forward messages to another conversation, planned as a delivery to it
   * that cannot wait ({@link sendNow}): under enforcement a forward nothing
   * authorized is a failed result, {@link CONNECTOR_DELIVERY_DENIED_CODE}.
   */
  async forward(input: GovernedForwardInput): Promise<OutboundResult> {
    const adapter = await this.dependencies.getAdapter(input.adapterId)
    const conversationKey = forwardConversationKey(
      input.adapterId,
      adapter?.meta.type,
      input.forward.target
    )
    return this.sendNow(
      {
        adapterId: input.adapterId,
        ...(conversationKey ? { conversationKey } : {}),
        source: input.source,
        authorization: input.authorization,
        auditKind: "delivery.forward_direct",
        ...(input.auditFields ? { auditFields: input.auditFields } : {}),
      },
      () => this.dependencies.forward(input.adapterId, input.forward)
    )
  }

  /**
   * Send an urgent push ({@link GovernedUrgentInput}). Under enforcement a
   * push to anyone nothing authorized is a failed result,
   * {@link CONNECTOR_DELIVERY_DENIED_CODE}, and nobody is notified.
   */
  async urgent(input: GovernedUrgentInput): Promise<OutboundResult> {
    const userIds = input.userIds.map((id) => id.trim())
    const recipients = userIds.map(
      (id): OutboundTarget =>
        personTarget(input.adapterId, id) ?? {
          kind: "unknown",
          channel: input.adapterId,
          recipient: "*",
        }
    )
    return this.sendNow(
      {
        adapterId: input.adapterId,
        ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}),
        recipients,
        source: input.source,
        authorization: input.authorization,
        auditKind: "delivery.urgent_direct",
        auditFields: {
          ...input.auditFields,
          messageId: input.messageId,
          recipientCount: userIds.length,
          ...(input.via ? { via: input.via } : {}),
        },
      },
      () => this.dependencies.sendUrgent(input.adapterId, input.messageId, userIds, input.via)
    )
  }

  /** Direct wire probe. Never use this for a business send. */
  async sendDiagnostic(adapterId: string, request: OutboundRequest): Promise<OutboundResult> {
    const adapter = await this.dependencies.getAdapter(adapterId)
    if (!adapter) {
      return {
        ok: false,
        error: { code: "adapter_not_found", message: adapterId, retryable: false },
      }
    }
    const result = await adapter.send(request)
    await Promise.resolve(
      this.dependencies.appendAudit({
        adapterId,
        kind: "delivery.diagnostic_direct",
        at: Date.now(),
        idempotencyKey: request.metadata.idempotencyKey,
        reason: result.ok ? "diagnostic_succeeded" : result.error?.code,
        fields: { governed: false, outcome: result.ok ? "succeeded" : "failed" },
      })
    ).catch(() => undefined)
    return result
  }

  /**
   * Plan an {@link ImmediateDeliveryInput} and, when the policy lets it go,
   * run `send`. A refusal is returned as a failed result
   * ({@link CONNECTOR_DELIVERY_DENIED_CODE}), the shape the direct callers
   * already return; a PII rejection throws {@link ConnectorDeliveryPiiError},
   * as a queued delivery's does.
   */
  async sendNow(
    input: ImmediateDeliveryInput,
    send: () => Promise<OutboundResult>
  ): Promise<OutboundResult> {
    const decision = await this.dependencies.planDelivery({
      adapterId: input.adapterId,
      conversationKey: input.conversationKey ?? "",
      source: input.source,
      authorization: input.authorization,
      immediate: true,
      ...(input.recipients ? { recipients: input.recipients } : {}),
    })
    const subject = {
      adapterId: input.adapterId,
      conversationKey: input.conversationKey ?? "",
      idempotencyKey: input.idempotencyKey,
      source: input.source,
    }
    if (decision.action !== "send") {
      // `immediate` turns a draft into a refusal; a draft here is a bug.
      const reason = decision.action === "deny" ? decision.reason : "unapproved"
      await this.recordReceipt(decision.receipt)
      await this.auditWithheld(subject, "outbound.denied", decision.receipt, { reason })
      return {
        ok: false,
        error: {
          code: CONNECTOR_DELIVERY_DENIED_CODE,
          message: new ConnectorDeliveryDeniedError(input.source, reason).message,
          retryable: false,
        },
      }
    }
    if (input.segments && !this.dependencies.piiGate(input.segments)) {
      throw new ConnectorDeliveryPiiError(input.source)
    }
    if (decision.receipt) await this.recordReceipt(decision.receipt)
    const result = await send()
    await Promise.resolve(
      this.dependencies.appendAudit({
        adapterId: input.adapterId,
        kind: input.auditKind,
        at: Date.now(),
        ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(result.ok ? {} : { reason: result.error?.code }),
        fields: {
          ...input.auditFields,
          source: input.source,
          governed: true,
          outcome: result.ok ? "succeeded" : "failed",
          ...(decision.authorizedBy
            ? {
                authority: decision.authorizedBy.authority,
                ...(decision.authorizedBy.receiptId
                  ? { receiptId: decision.authorizedBy.receiptId }
                  : {}),
              }
            : {}),
        },
      })
    ).catch(() => undefined)
    return result
  }

  private async deliver(inputs: readonly GovernedEnqueueInput[]): Promise<EnqueueGovernedResult[]> {
    if (inputs.length === 0) return []
    const decisions = await Promise.all(
      inputs.map((input) => this.dependencies.planDelivery(toPlanInput(input)))
    )

    const refused = decisions.findIndex((decision) => decision.action === "deny")
    if (refused >= 0) {
      for (const [index, decision] of decisions.entries()) {
        if (decision.action !== "deny") continue
        await this.recordReceipt(decision.receipt)
        await this.auditWithheld(inputs[index], "outbound.denied", decision.receipt, {
          reason: decision.reason,
        })
      }
      const decision = decisions[refused] as Extract<DeliveryDecision, { action: "deny" }>
      throw new ConnectorDeliveryDeniedError(inputs[refused].source, decision.reason)
    }

    const sends = inputs.flatMap((input, index) =>
      decisions[index].action === "send" ? [index] : []
    )
    for (const index of sends) this.assertPiiDecision(inputs[index])

    const results: EnqueueGovernedResult[] = new Array(inputs.length)
    if (sends.length > 0) {
      const persisted = sends.map((index) => {
        const decision = decisions[index] as Extract<DeliveryDecision, { action: "send" }>
        return toPersisted(inputs[index], decision.authorizedBy)
      })
      const rows =
        inputs.length === 1
          ? [await this.dependencies.persistOne(persisted[0])]
          : await this.dependencies.persistMany(persisted)
      sends.forEach((index, position) => {
        results[index] = { kind: "queued", job: rows[position] }
      })
      for (let index = 0; index < rows.length; index += AUDIT_WRITE_CONCURRENCY) {
        await Promise.all(
          rows.slice(index, index + AUDIT_WRITE_CONCURRENCY).map((row) => this.auditEnqueue(row))
        )
      }
    }

    for (const [index, decision] of decisions.entries()) {
      if (decision.action !== "draft") continue
      const input = inputs[index]
      const draft = await this.dependencies.createDraft({
        conversationKey: input.conversationKey,
        sessionId: decision.draftSessionId,
        segments: input.request.segments,
        // Approving the draft sends exactly this request through the bot it
        // was meant for (`approveDraftLocally`).
        outboundPreview: {
          ...input.request,
          conversationRef: { ...input.request.conversationRef, adapterId: input.adapterId },
        },
      })
      results[index] = { kind: "drafted", draft }
      await this.auditWithheld(input, "outbound.drafted", decision.receipt, { draftId: draft.id })
    }

    for (const decision of decisions) {
      if (decision.action !== "deny" && decision.receipt) {
        await this.recordReceipt(decision.receipt)
      }
    }
    return results
  }

  private async recordReceipt(receipt: DeliveryReceipt): Promise<void> {
    // The audit record must never be able to fail or block a delivery.
    await Promise.resolve(this.dependencies.recordReceipt(receipt)).catch((error) => {
      console.warn("[outbound] delivery receipt write failed", error)
    })
  }

  private assertPiiDecision(input: GovernedEnqueueInput): void {
    if (!AUTOMATED_SOURCES.has(input.source)) return
    if (!this.dependencies.piiGate(input.request.segments)) {
      throw new ConnectorDeliveryPiiError(input.source)
    }
  }

  private async auditWithheld(
    input: WithheldSubject | GovernedEnqueueInput,
    kind: "outbound.drafted" | "outbound.denied",
    receipt: DeliveryReceipt,
    fields: Record<string, unknown>
  ): Promise<void> {
    const idempotencyKey =
      "request" in input ? input.request.metadata.idempotencyKey : input.idempotencyKey
    await Promise.resolve(
      this.dependencies.appendAudit({
        adapterId: input.adapterId,
        kind,
        at: Date.now(),
        ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        fields: { source: input.source, receiptId: receipt.request.requestId, ...fields },
      })
    ).catch(() => undefined)
  }

  private async auditEnqueue(row: OutboundJobRow): Promise<void> {
    await Promise.resolve(
      this.dependencies.appendAudit({
        adapterId: row.adapterId,
        projectId: row.projectId,
        kind: "outbound.enqueued",
        at: row.createdAt,
        conversationKey: row.conversationKey,
        idempotencyKey: row.idempotencyKey,
        fields: {
          jobId: row.id,
          source: row.source,
          orderSeq: row.orderSeq,
          review:
            row.source === "manual" || row.source === "draft-approved"
              ? "human_reviewed"
              : "automated_pii_passed",
          ...(row.authorizedBy
            ? {
                authority: row.authorizedBy.authority,
                ...(row.authorizedBy.receiptId ? { receiptId: row.authorizedBy.receiptId } : {}),
              }
            : {}),
        },
      })
    ).catch(() => undefined)
  }
}

let singleton: ConnectorDeliveryGateway | null = null

export function getConnectorDeliveryGateway(): ConnectorDeliveryGateway {
  singleton ??= new ConnectorDeliveryGateway()
  return singleton
}

/**
 * Function seam for a delivery that is queued or refused, never drafted: a
 * person's own send, a reply or notice into its own conversation, a reroute.
 */
export function enqueueGoverned(input: InThreadEnqueueInput): Promise<OutboundJobInfo> {
  return getConnectorDeliveryGateway().enqueue(input)
}

/** Function seam for an automated forward ({@link ConnectorDeliveryGateway.forward}). */
export function forwardGoverned(input: GovernedForwardInput): Promise<OutboundResult> {
  return getConnectorDeliveryGateway().forward(input)
}

/** Function seam for an automated delivery the policy may hold as a draft. */
/** {@link ConnectorDeliveryGateway.urgent} on the shared gateway. */
export function urgentGoverned(input: GovernedUrgentInput): Promise<OutboundResult> {
  return getConnectorDeliveryGateway().urgent(input)
}

export function enqueueAuthorized(input: GovernedEnqueueInput): Promise<EnqueueGovernedResult> {
  return getConnectorDeliveryGateway().enqueueAuthorized(input)
}

/** Batch variant used by fan-out paths to share one persistence transaction and wake. */
export function enqueueGovernedMany(
  inputs: readonly GovernedEnqueueInput[]
): Promise<EnqueueGovernedResult[]> {
  return getConnectorDeliveryGateway().enqueueMany(inputs)
}

/** The job a delivery was queued as, or `undefined` when it was held as a draft. */
export function queuedJob(result: EnqueueGovernedResult): OutboundJobRow | undefined {
  return result.kind === "queued" ? result.job : undefined
}

export function __resetConnectorDeliveryGatewayForTesting(): void {
  singleton = null
}
