import type { BotEventEnvelopeV1 } from "@/types/bot/event"

import { BotExecutorUnavailableError, type BotExecutorContext } from "./types"
import { botTriggeredFrom, createWorkflowBotExecutor } from "./workflow"

function envelope(overrides: Partial<BotEventEnvelopeV1> = {}): BotEventEnvelopeV1 {
  return {
    eventId: "bev_1",
    deliveryId: "bdl_1",
    source: "integration",
    type: "pull_request.opened",
    installationId: "boti_1",
    triggerId: "opened",
    occurredAt: 1,
    receivedAt: 1,
    payload: { number: 42 },
    provenance: { selfProduced: false, depth: 0 },
    ...overrides,
  }
}

function ctx(overrides: Partial<BotExecutorContext> = {}): BotExecutorContext {
  return {
    runId: "run_bot_bdl_1",
    installationId: "boti_1",
    botId: "acme:triage",
    event: envelope(),
    config: { channel: "#ops" },
    signal: new AbortController().signal,
    step: {} as BotExecutorContext["step"],
    log: jest.fn(),
    progress: jest.fn(),
    installation: { id: "boti_1" } as BotExecutorContext["installation"],
    definition: {
      id: "acme:triage",
      name: "Triage",
      version: "1.0.0",
      executor: "workflow",
      workflow: "wf_triage",
      triggers: [],
      source: "plugin",
    },
    composition: { selection: { presetId: "standard" }, provenance: {} } as never,
    policy: {},
    ...overrides,
  }
}

describe("botTriggeredFrom", () => {
  it("records the run as Bot-driven", () => {
    expect(botTriggeredFrom(ctx()).source).toBe("bot")
  })

  it("carries the verified human behind the event", () => {
    const origin = botTriggeredFrom(
      ctx({
        event: envelope({
          actor: { kind: "human", id: "octocat", principalId: "usr_1", displayName: "Octocat" },
        }),
      })
    )
    expect(origin.initiator).toMatchObject({
      platformIdentityId: "octocat",
      principalId: "usr_1",
    })
  })

  it("carries no initiator when the source proved nobody", () => {
    // An unverified guess would widen who may tap Approve on anything the
    // workflow goes on to ask.
    expect(botTriggeredFrom(ctx()).initiator).toBeUndefined()
  })

  it("carries the conversation when the event arrived on one", () => {
    const origin = botTriggeredFrom(
      ctx({ event: envelope({ binding: { conversationKey: "c1", adapterId: "lark_1" } }) })
    )
    expect(origin).toMatchObject({ conversationKey: "c1", adapterId: "lark_1" })
  })
})

describe("createWorkflowBotExecutor", () => {
  it("runs the published deployment with the run id as the idempotency key", async () => {
    const execute = jest.fn().mockResolvedValue({ runId: "wfr_1" })
    const result = await createWorkflowBotExecutor({ execute })(ctx())

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf_triage",
        entrypoint: "bot",
        caller: "bot:boti_1",
        // A redelivered event must not start the workflow twice.
        idempotencyKey: "run_bot_bdl_1",
      })
    )
    expect(result).toMatchObject({ output: { workflowRunId: "wfr_1" } })
  })

  it("hands the workflow the event and the config as its payload", async () => {
    const execute = jest.fn().mockResolvedValue({})
    await createWorkflowBotExecutor({ execute })(ctx())

    expect(execute.mock.calls[0][0].payload).toEqual({
      event: envelope(),
      config: { channel: "#ops" },
    })
  })

  it("reports unavailable when the definition names no workflow", async () => {
    const context = ctx()
    delete context.definition.workflow
    await expect(createWorkflowBotExecutor({ execute: jest.fn() })(context)).rejects.toThrow(
      BotExecutorUnavailableError
    )
  })
})
