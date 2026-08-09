import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { appendAudit, type AuditEntryInput } from "./audit"
import { enqueueOutbound, enqueueOutboundMany, type EnqueueInput } from "@/lib/db/outbound-jobs"
import type { OutboundJobRow } from "@/lib/db/connector-types"
import type { OutboundRequest, OutboundResult, PlatformAdapter } from "@/types/connectors"

export type OutboundJobInfo = OutboundJobRow

const AUTOMATED_SOURCES = new Set<EnqueueInput["source"]>(["ai-run", "workflow", "skill", "plugin"])
const AUDIT_WRITE_CONCURRENCY = 16

export class ConnectorDeliveryPiiError extends Error {
  readonly code = "connector_delivery_pii_rejected"

  constructor(readonly source: EnqueueInput["source"]) {
    super(`Connector delivery from '${source}' was rejected by the fail-closed PII gate`)
    this.name = "ConnectorDeliveryPiiError"
  }
}

export interface ConnectorDeliveryGatewayDependencies {
  persistOne(input: EnqueueInput): Promise<OutboundJobRow>
  persistMany(inputs: readonly EnqueueInput[]): Promise<OutboundJobRow[]>
  getAdapter(adapterId: string): PlatformAdapter | undefined | Promise<PlatformAdapter | undefined>
  piiGate(value: unknown): boolean
  appendAudit(entry: AuditEntryInput): Promise<unknown>
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
}

/**
 * The single governed entry point for ordinary connector delivery.
 * Persistence stays in `lib/db/outbound-jobs`; policy, provenance and the
 * explicit diagnostic waiver live here so business callers cannot silently
 * bypass one while retaining the others.
 */
export class ConnectorDeliveryGateway {
  private readonly dependencies: ConnectorDeliveryGatewayDependencies

  constructor(dependencies: ConnectorDeliveryGatewayDependencies = defaultDependencies) {
    this.dependencies = dependencies
  }

  async enqueue(input: EnqueueInput): Promise<OutboundJobInfo> {
    this.assertPiiDecision(input)
    const row = await this.dependencies.persistOne(input)
    await this.auditEnqueue(row)
    return row
  }

  async enqueueMany(inputs: readonly EnqueueInput[]): Promise<OutboundJobInfo[]> {
    for (const input of inputs) this.assertPiiDecision(input)
    const rows = await this.dependencies.persistMany(inputs)
    for (let index = 0; index < rows.length; index += AUDIT_WRITE_CONCURRENCY) {
      await Promise.all(
        rows.slice(index, index + AUDIT_WRITE_CONCURRENCY).map((row) => this.auditEnqueue(row))
      )
    }
    return rows
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

  private assertPiiDecision(input: EnqueueInput): void {
    if (!AUTOMATED_SOURCES.has(input.source)) return
    if (!this.dependencies.piiGate(input.request.segments)) {
      throw new ConnectorDeliveryPiiError(input.source)
    }
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

/** Compatibility-friendly function seam for governed business callers. */
export function enqueueGoverned(input: EnqueueInput): Promise<OutboundJobInfo> {
  return getConnectorDeliveryGateway().enqueue(input)
}

/** Batch variant used by fan-out paths to share one persistence transaction and wake. */
export function enqueueGovernedMany(inputs: readonly EnqueueInput[]): Promise<OutboundJobInfo[]> {
  return getConnectorDeliveryGateway().enqueueMany(inputs)
}

export function __resetConnectorDeliveryGatewayForTesting(): void {
  singleton = null
}
