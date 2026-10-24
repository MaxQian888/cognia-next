import { hasNoLeakingPiiDeep } from "@cognia/redact"
import type { OutboundJobAuthorization } from "@cognia/plugin-contract/lib/db/connector-types"
import { appendAudit, type AuditEntryInput } from "./audit"
import { enqueueOutbound, enqueueOutboundMany, type EnqueueInput } from "@/lib/db/outbound-jobs"
import { createDraft, type CreateDraftInput } from "@/lib/db/connector-drafts"
import type { ConnectorDraftRow, OutboundJobRow, OutboundJobSource } from "@/lib/db/connector-types"
import {
  planDelivery,
  type DeliveryDecision,
  type DeliveryDenyReason,
  type DeliveryPlanInput,
  type DeliveryReceipt,
  type InThreadAuthorization,
  type OutboundAuthorization,
} from "@/lib/policy/action-review/plan-delivery"
import type { OutboundRequest, OutboundResult, PlatformAdapter } from "@/types/connectors"

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
    super(
      reason === "fenced"
        ? `Connector delivery from '${source}' was refused: a person refused this recipient for the current request`
        : `Connector delivery from '${source}' was refused: it named a conversation other than the one it answers`
    )
    this.name = "ConnectorDeliveryDeniedError"
  }
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

/** Queued for the outbound runner, or held as a draft for a person to approve. */
export type EnqueueGovernedResult =
  { kind: "queued"; job: OutboundJobRow } | { kind: "drafted"; draft: ConnectorDraftRow }

export interface ConnectorDeliveryGatewayDependencies {
  persistOne(input: EnqueueInput): Promise<OutboundJobRow>
  persistMany(inputs: readonly EnqueueInput[]): Promise<OutboundJobRow[]>
  getAdapter(adapterId: string): PlatformAdapter | undefined | Promise<PlatformAdapter | undefined>
  piiGate(value: unknown): boolean
  appendAudit(entry: AuditEntryInput): Promise<unknown>
  planDelivery(input: DeliveryPlanInput): Promise<DeliveryDecision>
  createDraft(input: CreateDraftInput): Promise<ConnectorDraftRow>
  recordReceipt(receipt: DeliveryReceipt): Promise<void>
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
    input: GovernedEnqueueInput,
    kind: "outbound.drafted" | "outbound.denied",
    receipt: DeliveryReceipt,
    fields: Record<string, unknown>
  ): Promise<void> {
    await Promise.resolve(
      this.dependencies.appendAudit({
        adapterId: input.adapterId,
        kind,
        at: Date.now(),
        conversationKey: input.conversationKey,
        idempotencyKey: input.request.metadata.idempotencyKey,
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

/** Function seam for an automated delivery the policy may hold as a draft. */
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
