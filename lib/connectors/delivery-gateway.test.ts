import type { ConnectorDraftRow, OutboundJobRow } from "@/lib/db/connector-types"
import type { EnqueueInput } from "@/lib/db/outbound-jobs"
import type {
  DeliveryDecision,
  DeliveryReceipt,
  OutboundAuthorization,
} from "@/lib/policy/action-review/plan-delivery"
import type { PlatformAdapter } from "@/types/connectors"
import {
  ConnectorDeliveryDeniedError,
  ConnectorDeliveryGateway,
  ConnectorDeliveryPiiError,
  queuedJob,
  type ConnectorDeliveryGatewayDependencies,
  type GovernedEnqueueInput,
  type InThreadEnqueueInput,
} from "./delivery-gateway"

const unattended: OutboundAuthorization = { kind: "unattended", ownerRef: "task:t1" }

function input(
  source: EnqueueInput["source"],
  authorization: OutboundAuthorization = unattended
): GovernedEnqueueInput {
  return {
    adapterId: "adapter-1",
    conversationKey: "slack:adapter-1:C1",
    request: {
      conversationRef: { platform: "slack", adapterId: "adapter-1", channelId: "C1" },
      segments: [{ type: "text", text: "hello" }],
      metadata: { idempotencyKey: `idem-${source}` },
    },
    source,
    ...(source === "manual" || source === "draft-approved" ? {} : { authorization }),
  } as GovernedEnqueueInput
}

function rowFor(value: EnqueueInput, sequence = 1): OutboundJobRow {
  return {
    id: `job-${sequence}`,
    adapterId: value.adapterId,
    conversationKey: value.conversationKey,
    request: value.request,
    status: "pending",
    attempts: 0,
    createdAt: 100,
    nextAttemptAt: value.nextAttemptAt ?? 100,
    idempotencyKey: value.request.metadata.idempotencyKey,
    source: value.source,
    orderSeq: sequence,
    ...(value.authorizedBy ? { authorizedBy: value.authorizedBy } : {}),
  }
}

function receipt(id: string): DeliveryReceipt {
  return {
    request: { requestId: id } as DeliveryReceipt["request"],
    decision: { requestId: id } as DeliveryReceipt["decision"],
  }
}

function gatewayWith(overrides: Partial<ConnectorDeliveryGatewayDependencies> = {}) {
  const deps: ConnectorDeliveryGatewayDependencies = {
    persistOne: jest.fn(async (value: EnqueueInput) => rowFor(value)),
    persistMany: jest.fn(async (values: readonly EnqueueInput[]) =>
      values.map((value, index) => rowFor(value, index + 1))
    ),
    getAdapter: jest.fn(),
    piiGate: () => true,
    appendAudit: jest.fn(async () => undefined),
    planDelivery: jest.fn(async (): Promise<DeliveryDecision> => ({ action: "send" })),
    createDraft: jest.fn(
      async (value) =>
        ({
          id: "cdr_1",
          conversationKey: value.conversationKey,
          sessionId: value.sessionId,
          segments: value.segments,
          status: "pending",
          createdAt: 1,
          outboundPreview: value.outboundPreview,
        }) satisfies ConnectorDraftRow
    ),
    recordReceipt: jest.fn(async () => undefined),
    ...overrides,
  }
  return { gateway: new ConnectorDeliveryGateway(deps), deps }
}

describe("ConnectorDeliveryGateway", () => {
  it.each(["ai-run", "workflow", "skill", "plugin"] as const)(
    "fails closed before persistence for automated source %s",
    async (source) => {
      const { gateway, deps } = gatewayWith({ piiGate: () => false })

      await expect(gateway.enqueueAuthorized(input(source))).rejects.toBeInstanceOf(
        ConnectorDeliveryPiiError
      )
      expect(deps.persistOne).not.toHaveBeenCalled()
    }
  )

  it.each(["manual", "draft-approved"] as const)(
    "records reviewed provenance without changing %s delivery semantics",
    async (source) => {
      const { gateway, deps } = gatewayWith({ piiGate: () => false })

      const result = await gateway.enqueue({ ...input(source), source } as InThreadEnqueueInput)

      expect(result.source).toBe(source)
      expect(deps.persistOne).toHaveBeenCalledWith(expect.objectContaining({ source }))
      expect(deps.appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "outbound.enqueued",
          fields: expect.objectContaining({ source, review: "human_reviewed" }),
        })
      )
    }
  )

  it("plans every delivery and hands the planner what the caller claimed", async () => {
    const { gateway, deps } = gatewayWith()
    const authorization: OutboundAuthorization = {
      kind: "origin-reply",
      inboundConversationKey: "slack:adapter-1:C1",
    }

    await gateway.enqueue({ ...input("ai-run"), source: "ai-run", authorization })

    expect(deps.planDelivery).toHaveBeenCalledWith({
      adapterId: "adapter-1",
      conversationKey: "slack:adapter-1:C1",
      source: "ai-run",
      authorization,
    })
    // The claim is the gateway's to read, never persisted.
    expect(deps.persistOne).toHaveBeenCalledWith(
      expect.not.objectContaining({ authorization: expect.anything() })
    )
  })

  it("persists what authorized a queued delivery and audits it", async () => {
    const { gateway, deps } = gatewayWith({
      planDelivery: jest.fn(async () => ({
        action: "send" as const,
        authorizedBy: {
          receiptId: "req_1",
          authority: "human" as const,
          grantScope: "once" as const,
        },
      })),
    })

    const result = await gateway.enqueueAuthorized(input("skill"))

    expect(queuedJob(result)?.authorizedBy).toEqual({
      receiptId: "req_1",
      authority: "human",
      grantScope: "once",
    })
    expect(deps.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "outbound.enqueued",
        fields: expect.objectContaining({ authority: "human", receiptId: "req_1" }),
      })
    )
  })

  it("holds a delivery as a draft instead of queueing it, with its receipt", async () => {
    const { gateway, deps } = gatewayWith({
      planDelivery: jest.fn(async () => ({
        action: "draft" as const,
        draftSessionId: "task:t1",
        receipt: receipt("delivery:1"),
      })),
    })

    const result = await gateway.enqueueAuthorized(input("ai-run"))

    expect(result.kind).toBe("drafted")
    expect(queuedJob(result)).toBeUndefined()
    expect(deps.persistOne).not.toHaveBeenCalled()
    expect(deps.createDraft).toHaveBeenCalledWith({
      conversationKey: "slack:adapter-1:C1",
      sessionId: "task:t1",
      segments: [{ type: "text", text: "hello" }],
      outboundPreview: expect.objectContaining({
        conversationRef: expect.objectContaining({ adapterId: "adapter-1" }),
        metadata: { idempotencyKey: "idem-ai-run" },
      }),
    })
    expect(deps.recordReceipt).toHaveBeenCalledWith(receipt("delivery:1"))
    expect(deps.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "outbound.drafted",
        fields: expect.objectContaining({ draftId: "cdr_1", receiptId: "delivery:1" }),
      })
    )
  })

  it("does not PII-gate a draft: a person reads it before it is sent", async () => {
    const { gateway, deps } = gatewayWith({
      piiGate: () => false,
      planDelivery: jest.fn(async () => ({
        action: "draft" as const,
        draftSessionId: "s1",
        receipt: receipt("delivery:1"),
      })),
    })

    await expect(gateway.enqueueAuthorized(input("ai-run"))).resolves.toMatchObject({
      kind: "drafted",
    })
    expect(deps.createDraft).toHaveBeenCalled()
  })

  it("refuses a denied delivery before anything is persisted", async () => {
    const { gateway, deps } = gatewayWith({
      planDelivery: jest.fn(async () => ({
        action: "deny" as const,
        reason: "fenced" as const,
        receipt: receipt("delivery:2"),
      })),
    })

    const attempt = gateway.enqueueAuthorized(input("skill"))
    await expect(attempt).rejects.toBeInstanceOf(ConnectorDeliveryDeniedError)
    await expect(attempt).rejects.toMatchObject({
      reason: "fenced",
      code: "connector_delivery_denied",
    })
    expect(deps.persistOne).not.toHaveBeenCalled()
    expect(deps.createDraft).not.toHaveBeenCalled()
    expect(deps.recordReceipt).toHaveBeenCalledWith(receipt("delivery:2"))
    expect(deps.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "outbound.denied",
        fields: expect.objectContaining({ reason: "fenced", receiptId: "delivery:2" }),
      })
    )
  })

  it("refuses the whole batch when one delivery is denied", async () => {
    const planDelivery = jest
      .fn<Promise<DeliveryDecision>, []>()
      .mockResolvedValueOnce({ action: "send" })
      .mockResolvedValueOnce({
        action: "deny",
        reason: "fenced",
        receipt: receipt("delivery:3"),
      })
    const { gateway, deps } = gatewayWith({ planDelivery })

    await expect(
      gateway.enqueueMany([input("skill"), { ...input("skill"), conversationKey: "slack:a:C2" }])
    ).rejects.toBeInstanceOf(ConnectorDeliveryDeniedError)
    expect(deps.persistMany).not.toHaveBeenCalled()
  })

  it("queues and drafts within one batch, results in input order", async () => {
    const planDelivery = jest
      .fn<Promise<DeliveryDecision>, []>()
      .mockResolvedValueOnce({
        action: "draft",
        draftSessionId: "s1",
        receipt: receipt("delivery:4"),
      })
      .mockResolvedValueOnce({ action: "send", authorizedBy: { authority: "policy-default" } })
    const { gateway, deps } = gatewayWith({ planDelivery })

    const results = await gateway.enqueueMany([
      input("skill"),
      { ...input("skill"), conversationKey: "slack:adapter-1:C2" },
    ])

    expect(results.map((r) => r.kind)).toEqual(["drafted", "queued"])
    expect(deps.persistMany).toHaveBeenCalledWith([
      expect.objectContaining({
        conversationKey: "slack:adapter-1:C2",
        authorizedBy: { authority: "policy-default" },
      }),
    ])
  })

  it("writes a shadow receipt for a delivery it still queues", async () => {
    const { gateway, deps } = gatewayWith({
      planDelivery: jest.fn(async () => ({
        action: "send" as const,
        receipt: receipt("delivery:5"),
      })),
    })

    await expect(gateway.enqueueAuthorized(input("workflow"))).resolves.toMatchObject({
      kind: "queued",
    })
    expect(deps.recordReceipt).toHaveBeenCalledWith(receipt("delivery:5"))
  })

  it("never lets a failed receipt write fail the delivery", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const { gateway } = gatewayWith({
      planDelivery: jest.fn(async () => ({
        action: "send" as const,
        receipt: receipt("delivery:6"),
      })),
      recordReceipt: jest.fn(async () => {
        throw new Error("disk full")
      }),
    })

    await expect(gateway.enqueueAuthorized(input("workflow"))).resolves.toMatchObject({
      kind: "queued",
    })
    warn.mockRestore()
  })

  it("validates an automated batch before one durable bulk write", async () => {
    const piiGate = jest.fn(() => true)
    const { gateway, deps } = gatewayWith({ piiGate })
    const values = [input("workflow"), { ...input("workflow"), conversationKey: "slack:a:C2" }]

    const rows = await gateway.enqueueMany(values)

    expect(rows).toHaveLength(2)
    expect(piiGate).toHaveBeenCalledTimes(2)
    expect(deps.persistMany).toHaveBeenCalledTimes(1)
    expect(deps.persistMany).toHaveBeenCalledWith(
      values.map(({ authorization: _authorization, ...rest }) => rest)
    )
  })

  it("bounds provenance audit writes for a large batch", async () => {
    let active = 0
    let maxActive = 0
    const values = Array.from({ length: 40 }, (_, index) => ({
      ...input("workflow"),
      conversationKey: `slack:adapter-1:C${index}`,
    }))
    const { gateway } = gatewayWith({
      appendAudit: async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await Promise.resolve()
        active -= 1
      },
    })

    await gateway.enqueueMany(values)

    expect(maxActive).toBeLessThanOrEqual(16)
  })

  it("uses direct adapter send only for an explicit diagnostic", async () => {
    const send = jest.fn(async () => ({ ok: true, platformMessageId: "remote-1" }))
    const adapter = { id: "adapter-1", send } as unknown as PlatformAdapter
    const { gateway } = gatewayWith({ getAdapter: () => adapter })
    const request = input("manual").request

    await expect(gateway.sendDiagnostic("adapter-1", request)).resolves.toEqual({
      ok: true,
      platformMessageId: "remote-1",
    })
    expect(send).toHaveBeenCalledWith(request)
  })

  it("returns the existing structured error when a diagnostic adapter is absent", async () => {
    const { gateway } = gatewayWith({ getAdapter: () => undefined })

    await expect(gateway.sendDiagnostic("missing", input("manual").request)).resolves.toEqual({
      ok: false,
      error: { code: "adapter_not_found", message: "missing", retryable: false },
    })
  })
})
