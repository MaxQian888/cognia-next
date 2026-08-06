import type { OutboundJobRow } from "@/lib/db/connector-types"
import type { EnqueueInput } from "@/lib/db/outbound-jobs"
import type { PlatformAdapter } from "@/types/connectors"
import { ConnectorDeliveryGateway, ConnectorDeliveryPiiError } from "./delivery-gateway"

function input(source: EnqueueInput["source"]): EnqueueInput {
  return {
    adapterId: "adapter-1",
    conversationKey: "slack:adapter-1:C1",
    request: {
      conversationRef: { platform: "slack", adapterId: "adapter-1", channelId: "C1" },
      segments: [{ type: "text", text: "hello" }],
      metadata: { idempotencyKey: `idem-${source}` },
    },
    source,
  }
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
  }
}

describe("ConnectorDeliveryGateway", () => {
  it.each(["ai-run", "workflow", "skill", "plugin"] as const)(
    "fails closed before persistence for automated source %s",
    async (source) => {
      const persist = jest.fn()
      const gateway = new ConnectorDeliveryGateway({
        persistOne: persist,
        persistMany: jest.fn(),
        getAdapter: jest.fn(),
        piiGate: () => false,
        appendAudit: jest.fn(),
      })

      await expect(gateway.enqueue(input(source))).rejects.toBeInstanceOf(ConnectorDeliveryPiiError)
      expect(persist).not.toHaveBeenCalled()
    }
  )

  it.each(["manual", "draft-approved"] as const)(
    "records reviewed provenance without changing %s delivery semantics",
    async (source) => {
      const persistOne = jest.fn(async (value: EnqueueInput) => rowFor(value))
      const appendAudit = jest.fn(async () => undefined)
      const gateway = new ConnectorDeliveryGateway({
        persistOne,
        persistMany: jest.fn(),
        getAdapter: jest.fn(),
        piiGate: () => false,
        appendAudit,
      })

      const result = await gateway.enqueue(input(source))

      expect(result.source).toBe(source)
      expect(persistOne).toHaveBeenCalledWith(expect.objectContaining({ source }))
      expect(appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "outbound.enqueued",
          fields: expect.objectContaining({ source, review: "human_reviewed" }),
        })
      )
    }
  )

  it("validates an automated batch before one durable bulk write", async () => {
    const persistMany = jest.fn(async (values: EnqueueInput[]) =>
      values.map((value, index) => rowFor(value, index + 1))
    )
    const piiGate = jest.fn(() => true)
    const gateway = new ConnectorDeliveryGateway({
      persistOne: jest.fn(),
      persistMany,
      getAdapter: jest.fn(),
      piiGate,
      appendAudit: jest.fn(async () => undefined),
    })
    const values = [input("workflow"), { ...input("workflow"), conversationKey: "slack:a:C2" }]

    const rows = await gateway.enqueueMany(values)

    expect(rows).toHaveLength(2)
    expect(piiGate).toHaveBeenCalledTimes(2)
    expect(persistMany).toHaveBeenCalledTimes(1)
    expect(persistMany).toHaveBeenCalledWith(values)
  })

  it("bounds provenance audit writes for a large batch", async () => {
    let active = 0
    let maxActive = 0
    const values = Array.from({ length: 40 }, (_, index) => ({
      ...input("workflow"),
      conversationKey: `slack:adapter-1:C${index}`,
    }))
    const gateway = new ConnectorDeliveryGateway({
      persistOne: jest.fn(),
      persistMany: async (batch) => batch.map((value, index) => rowFor(value, index + 1)),
      getAdapter: jest.fn(),
      piiGate: () => true,
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
    const gateway = new ConnectorDeliveryGateway({
      persistOne: jest.fn(),
      persistMany: jest.fn(),
      getAdapter: () => adapter,
      piiGate: () => true,
      appendAudit: jest.fn(),
    })
    const request = input("manual").request

    await expect(gateway.sendDiagnostic("adapter-1", request)).resolves.toEqual({
      ok: true,
      platformMessageId: "remote-1",
    })
    expect(send).toHaveBeenCalledWith(request)
  })

  it("returns the existing structured error when a diagnostic adapter is absent", async () => {
    const gateway = new ConnectorDeliveryGateway({
      persistOne: jest.fn(),
      persistMany: jest.fn(),
      getAdapter: () => undefined,
      piiGate: () => true,
      appendAudit: jest.fn(),
    })

    await expect(gateway.sendDiagnostic("missing", input("manual").request)).resolves.toEqual({
      ok: false,
      error: { code: "adapter_not_found", message: "missing", retryable: false },
    })
  })
})
