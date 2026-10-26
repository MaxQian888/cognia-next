import type { ConnectorDraftRow, OutboundJobRow } from "@/lib/db/connector-types"
import type { EnqueueInput } from "@/lib/db/outbound-jobs"
import type {
  DeliveryDecision,
  DeliveryReceipt,
  OutboundAuthorization,
} from "@/lib/policy/action-review/plan-delivery"
import type { PlatformAdapter } from "@/types/connectors"
import {
  CONNECTOR_DELIVERY_DENIED_CODE,
  ConnectorDeliveryDeniedError,
  ConnectorDeliveryGateway,
  ConnectorDeliveryPiiError,
  forwardConversationKey,
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
    messagingMode: async () => "shadow" as const,
    forward: jest.fn(async () => ({ ok: true })),
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

describe("ConnectorDeliveryGateway.sendNow (ADR-0239)", () => {
  const plugin: OutboundAuthorization = { kind: "plugin", pluginId: "p1" }
  const immediate = (extra: Record<string, unknown> = {}) => ({
    adapterId: "adapter-1",
    conversationKey: "slack:adapter-1:C1",
    segments: [{ type: "text" as const, text: "hello" }],
    idempotencyKey: "idem-1",
    source: "plugin" as const,
    authorization: plugin,
    auditKind: "delivery.legacy_direct" as const,
    auditFields: { pluginId: "p1" },
    ...extra,
  })

  it("plans it as a delivery that cannot wait, then sends and audits it", async () => {
    const { gateway, deps } = gatewayWith({
      planDelivery: jest.fn(async (): Promise<DeliveryDecision> => ({
        action: "send",
        authorizedBy: { authority: "policy-rule", receiptId: "r1", grantScope: "policy" },
        receipt: receipt("r1"),
      })),
    })
    const send = jest.fn(async () => ({ ok: true, platformMessageId: "m1" }))

    await expect(gateway.sendNow(immediate(), send)).resolves.toEqual({
      ok: true,
      platformMessageId: "m1",
    })
    expect(deps.planDelivery).toHaveBeenCalledWith({
      adapterId: "adapter-1",
      conversationKey: "slack:adapter-1:C1",
      source: "plugin",
      authorization: plugin,
      immediate: true,
    })
    expect(deps.recordReceipt).toHaveBeenCalledWith(receipt("r1"))
    expect(deps.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "delivery.legacy_direct",
        conversationKey: "slack:adapter-1:C1",
        idempotencyKey: "idem-1",
        fields: {
          pluginId: "p1",
          source: "plugin",
          governed: true,
          outcome: "succeeded",
          authority: "policy-rule",
          receiptId: "r1",
        },
      })
    )
  })

  it("plans a request with no conversation as one with an unknown recipient", async () => {
    const { gateway, deps } = gatewayWith()
    await gateway.sendNow(immediate({ conversationKey: undefined }), async () => ({ ok: true }))
    expect(deps.planDelivery).toHaveBeenCalledWith(expect.objectContaining({ conversationKey: "" }))
  })

  it("returns a refusal as a failed result and never sends", async () => {
    const { gateway, deps } = gatewayWith({
      planDelivery: jest.fn(async (): Promise<DeliveryDecision> => ({
        action: "deny",
        reason: "unapproved",
        receipt: receipt("r2"),
      })),
    })
    const send = jest.fn(async () => ({ ok: true }))

    const result = await gateway.sendNow(immediate(), send)
    expect(result).toEqual({
      ok: false,
      error: {
        code: CONNECTOR_DELIVERY_DENIED_CODE,
        message: new ConnectorDeliveryDeniedError("plugin", "unapproved").message,
        retryable: false,
      },
    })
    expect(result.error?.message).toMatch(/cannot wait for a person/)
    expect(send).not.toHaveBeenCalled()
    expect(deps.recordReceipt).toHaveBeenCalledWith(receipt("r2"))
    expect(deps.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "outbound.denied",
        fields: expect.objectContaining({ receiptId: "r2", reason: "unapproved" }),
      })
    )
  })

  it("PII-gates what it sends, but not a forward, which sends nothing new", async () => {
    const { gateway } = gatewayWith({ piiGate: () => false })
    const send = jest.fn(async () => ({ ok: true }))
    await expect(gateway.sendNow(immediate(), send)).rejects.toBeInstanceOf(
      ConnectorDeliveryPiiError
    )
    expect(send).not.toHaveBeenCalled()
    await expect(
      gateway.sendNow(
        immediate({ segments: undefined, auditKind: "delivery.forward_direct" }),
        send
      )
    ).resolves.toEqual({ ok: true })
  })

  it("audits a failed send with its error code", async () => {
    const { gateway, deps } = gatewayWith()
    await gateway.sendNow(immediate(), async () => ({
      ok: false,
      error: { code: "platform_4xx", message: "no", retryable: false },
    }))
    expect(deps.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "delivery.legacy_direct",
        reason: "platform_4xx",
        fields: expect.objectContaining({ outcome: "failed" }),
      })
    )
  })
})

describe("ConnectorDeliveryGateway.allowsUnplannedStream (ADR-0239)", () => {
  it("allows a stream only while messaging is not enforced", async () => {
    await expect(
      gatewayWith({ messagingMode: async () => "shadow" }).gateway.allowsUnplannedStream()
    ).resolves.toBe(true)
    await expect(
      gatewayWith({ messagingMode: async () => "enforce" }).gateway.allowsUnplannedStream()
    ).resolves.toBe(false)
  })

  it("fails closed when the mode cannot be read", async () => {
    const { gateway } = gatewayWith({
      messagingMode: async () => {
        throw new Error("settings unavailable")
      },
    })
    await expect(gateway.allowsUnplannedStream()).resolves.toBe(false)
  })
})

describe("forwardConversationKey", () => {
  it("reads a key of the adapter, or a bare chat id on its platform", () => {
    expect(forwardConversationKey("bot-a", "lark", "lark:bot-a:oc_2")).toBe("lark:bot-a:oc_2")
    expect(forwardConversationKey("bot-a", "lark", " oc_3 ")).toBe("lark:bot-a:oc_3")
  })

  it("names nothing for another bot's key, a malformed one, or an unknown platform", () => {
    expect(forwardConversationKey("bot-a", "lark", "lark:bot-b:oc_2")).toBeUndefined()
    expect(forwardConversationKey("bot-a", "lark", "lark:")).toBeUndefined()
    expect(forwardConversationKey("bot-a", undefined, "oc_3")).toBeUndefined()
    expect(forwardConversationKey("bot-a", "lark", "  ")).toBeUndefined()
  })
})

describe("ConnectorDeliveryGateway.forward (ADR-0239)", () => {
  const larkAdapter = { id: "bot-a", meta: { type: "lark" } } as unknown as PlatformAdapter
  const input = {
    adapterId: "bot-a",
    forward: { messageId: "om_1", target: "oc_2" },
    source: "plugin" as const,
    authorization: { kind: "plugin", pluginId: "p1" } as OutboundAuthorization,
    auditFields: { pluginId: "p1" },
  }

  it("plans the forward as a delivery to its target, then forwards", async () => {
    const forward = jest.fn(async () => ({ ok: true, platformMessageId: "om_f" }))
    const { gateway, deps } = gatewayWith({ getAdapter: () => larkAdapter, forward })

    await expect(gateway.forward(input)).resolves.toEqual({ ok: true, platformMessageId: "om_f" })
    expect(deps.planDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ conversationKey: "lark:bot-a:oc_2", immediate: true })
    )
    expect(forward).toHaveBeenCalledWith("bot-a", input.forward)
    expect(deps.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "delivery.forward_direct" })
    )
  })

  it("never forwards what the policy refused", async () => {
    const forward = jest.fn(async () => ({ ok: true }))
    const { gateway } = gatewayWith({
      getAdapter: () => larkAdapter,
      forward,
      planDelivery: jest.fn(async (): Promise<DeliveryDecision> => ({
        action: "deny",
        reason: "unapproved",
        receipt: receipt("r3"),
      })),
    })
    await expect(gateway.forward(input)).resolves.toMatchObject({
      ok: false,
      error: { code: CONNECTOR_DELIVERY_DENIED_CODE },
    })
    expect(forward).not.toHaveBeenCalled()
  })
})
