/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { enqueueBotDelivery } from "@/lib/db/bot-event-deliveries"
import { getBotRunStep } from "@/lib/db/bot-run-steps"
import { createExecutionRun, runEventJournal } from "@/lib/db/execution-runs"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { BotEventEnvelopeV1 } from "@/types/bot/event"
import type { ExecutionRun } from "@/types/execution/run"
import { safeStableActivityId } from "@/lib/execution/run-activity"
import { handleExecutionRunControl } from "@/lib/companion/execution-run-control-handler"
import { registerRunControlHandler } from "@/lib/execution/run-control"
import { resolveOwnedBotAuthority } from "@/lib/bot/policy/run-authority"
jest.mock("@/lib/bot/policy/run-authority", () => ({ resolveOwnedBotAuthority: jest.fn() }))

import {
  BotRunCancelledError,
  BotRunParkedError,
  botApprovalInterruptId,
  createBotStepApi,
} from "./step"

const NOW = 1_700_000_000_000
const RUN_ID = "run_bot_1"

let clock = NOW
const now = () => clock
const sleep = async () => {
  // Advance far enough that a polling wait makes progress toward its deadline
  // without any real timers.
  clock += 500
}

/**
 * The blocking wait, which after parking landed has exactly one caller: the
 * Squad executor's plan-approval delegate, invoked from a detached lifecycle
 * where a thrown park would have nowhere to unwind to.
 */
function api(signal = new AbortController().signal) {
  return createBotStepApi({
    runId: RUN_ID,
    signal,
    deps: { now, sleep, pollIntervalMs: 1, waitMode: "block" },
  })
}

/** The default: an unanswered wait leaves the queue. */
function parkingApi(signal = new AbortController().signal) {
  return createBotStepApi({
    runId: RUN_ID,
    signal,
    deps: { now, sleep, parkIntervalMs: 20_000 },
  })
}

async function seedRun(): Promise<ExecutionRun> {
  return createExecutionRun({
    id: RUN_ID,
    kind: "bot",
    sourceId: "boti_1",
    title: "Digest",
    status: "running",
    currentRevision: 0,
    startedAt: NOW,
    updatedAt: NOW,
  })
}

function envelope(correlation: string): BotEventEnvelopeV1 {
  return {
    eventId: "bev_ci",
    deliveryId: "bdl_ci",
    source: "integration",
    type: "workflow_run.completed",
    installationId: "boti_1",
    triggerId: "ci",
    occurredAt: NOW,
    receivedAt: NOW,
    payload: { conclusion: "success" },
    provenance: { selfProduced: false, depth: 0 },
    correlation,
  }
}

beforeEach(async () => {
  jest
    .mocked(resolveOwnedBotAuthority)
    .mockReset()
    .mockResolvedValue({
      installation: { id: "boti_1" },
      automatedPublicationAllowed: true,
    } as never)
  __resetDbForTesting()
  clock = NOW
  const db = getDb()
  await db.botRunSteps.clear()
  await db.executionRuns.clear()
  await db.executionRunEvents.clear()
  await db.executionRunInterrupts.clear()
  await db.botEventDeliveries.clear()
  await seedRun()
}, 15_000)

async function waitForInterrupt(interruptId: string) {
  // The wait loop creates the row asynchronously. Polling for it is what makes
  // this test deterministic instead of racing a fixed number of ticks.
  for (let i = 0; i < 200; i++) {
    const row = await getDb().executionRunInterrupts.get(interruptId)
    if (row) return row
    await new Promise((r) => setTimeout(r, 0))
  }
  throw new Error(`interrupt ${interruptId} was never created`)
}

describe("botApprovalInterruptId", () => {
  it("keeps long command and publication approval references exact through the redacted journal", async () => {
    const runId = `run_bot_bdl_repo/issue/23/${"revision".repeat(20)}`
    await createExecutionRun({ ...(await getDb().executionRuns.get(RUN_ID))!, id: runId })
    const steps = createBotStepApi({ runId, signal: new AbortController().signal, deps: { now } })
    const command = `external-command-${"a".repeat(64)}`
    await expect(
      steps.waitForApproval(command, {
        title: "private.person@example.com",
        detail: { command: "pnpm test" },
      })
    ).rejects.toBeInstanceOf(BotRunParkedError)
    const id = await botApprovalInterruptId(runId, command)
    expect(id).toMatch(/^bot-approval:[a-f0-9]{64}$/)
    expect(safeStableActivityId(id)).toBe(id)
    const snapshot = (await getDb().executionRuns.get(runId))!.latestSnapshot!
    expect(snapshot.pendingInterrupt?.id).toBe(id)
    expect((await getDb().executionRunInterrupts.get(id))?.id).toBe(id)
    expect(JSON.stringify(await runEventJournal.replay(runId))).not.toContain(
      "private.person@example.com"
    )
    expect(safeStableActivityId(await botApprovalInterruptId(runId, "publish"))).toBe(
      await botApprovalInterruptId(runId, "publish")
    )

    const handler = jest.fn(async () => undefined)
    const unregister = registerRunControlHandler("bot", handler)
    try {
      const result = await handleExecutionRunControl(
        {
          runId,
          action: "approve",
          expectedRevision: snapshot.revision,
          idempotencyKey: "paired-approve",
          interruptId: snapshot.pendingInterrupt!.id,
          callerDeviceId: "verified-phone",
          deviceId: "spoofed-device",
        },
        {
          execute: (control, options) =>
            import("@/lib/execution/run-control").then(({ executeRunControlCommand }) =>
              executeRunControlCommand(control, { ...options, now: NOW })
            ),
        }
      )
      expect(result).toMatchObject({ accepted: true })
      expect(handler).toHaveBeenCalledTimes(1)
      expect((await getDb().executionRunInterrupts.get(id))?.status).toBe("approved")
    } finally {
      unregister()
    }
  })

  it("preserves the exact legacy decision row rather than issuing a second approval", async () => {
    const legacyId = `bot-approval:${RUN_ID}:publish`
    await getDb().executionRunInterrupts.add({
      id: legacyId,
      runId: RUN_ID,
      type: "bot_approval",
      status: "approved",
      title: "Publish",
      createdAt: NOW,
      expiresAt: NOW + 60_000,
      resolvedAt: NOW,
    })
    expect(await parkingApi().waitForApproval("publish", { title: "Publish" })).toMatchObject({
      approvalId: legacyId,
      outcome: "approved",
    })
    expect(await getDb().executionRunInterrupts.count()).toBe(1)
  })

  it("rejects a legacy key collision owned by another run", async () => {
    await getDb().executionRunInterrupts.add({
      id: `bot-approval:${RUN_ID}:publish`,
      runId: `${RUN_ID}:publish`,
      type: "bot_approval",
      status: "approved",
      title: "Publish",
      createdAt: NOW,
      expiresAt: NOW + 60_000,
    })
    await expect(parkingApi().waitForApproval("publish", { title: "Publish" })).rejects.toThrow(
      "another run"
    )
  })
  it.each(["title", "message"] as const)("invalidates changed approval %s", async (field) => {
    const request = { title: "Publish", message: "Exact review text" }
    await expect(parkingApi().waitForApproval("publish", request)).rejects.toBeInstanceOf(
      BotRunParkedError
    )
    await expect(
      parkingApi().waitForApproval("publish", { ...request, [field]: "Changed text" })
    ).rejects.toThrow("content changed")
  })

  it.each(["denied", "expired"] as const)(
    "retains a %s decision without actor metadata",
    async (status) => {
      await expect(
        parkingApi().waitForApproval("publish", { title: "Publish" })
      ).rejects.toBeInstanceOf(BotRunParkedError)
      const id = await botApprovalInterruptId(RUN_ID, "publish")
      await getDb().executionRunInterrupts.update(id, { status, resolvedBy: {} })
      expect(await parkingApi().waitForApproval("publish", { title: "Publish" })).toEqual({
        approvalId: id,
        outcome: status,
        decidedAt: NOW,
        decidedBy: {},
      })
    }
  )

  it("uses the default blocking timer and expires a project approval", async () => {
    const steps = createBotStepApi({
      runId: RUN_ID,
      projectId: "project-1",
      signal: new AbortController().signal,
      deps: { waitMode: "block", pollIntervalMs: 1 },
    })
    const result = await steps.waitForApproval("timed", { title: "Publish", timeoutMs: 5 })
    expect(result.outcome).toBe("expired")
    expect(
      await getDb().executionRunInterrupts.get(await botApprovalInterruptId(RUN_ID, "timed"))
    ).toMatchObject({
      projectId: "project-1",
      status: "expired",
    })
  })

  it("preserves non-Error step failures in durable recovery evidence", async () => {
    await expect(
      api().run("implementation", () => Promise.reject("provider stopped"))
    ).rejects.toBe("provider stopped")
    expect(await getBotRunStep(RUN_ID, "implementation")).toMatchObject({
      status: "failed",
      error: "provider stopped",
    })
  })

  it("persists immutable concrete contents with a seven-day deadline", async () => {
    const request = { title: "Publish", detail: { snapshot: { id: "sha", diff: "+change" } } }
    await expect(parkingApi().waitForApproval("publish", request)).rejects.toBeInstanceOf(
      BotRunParkedError
    )
    const saved = await getDb().executionRunInterrupts.get(
      await botApprovalInterruptId(RUN_ID, "publish")
    )
    expect(saved?.approvalDetail).toEqual(request.detail)
    expect(saved?.expiresAt).toBe(NOW + 7 * 24 * 60 * 60_000)
    await expect(
      parkingApi().waitForApproval("publish", {
        ...request,
        detail: { snapshot: { id: "changed" } },
      })
    ).rejects.toThrow("content changed")
    expect((await getDb().executionRunInterrupts.get(saved!.id))?.status).toBe("expired")
  })

  it("reserves host checkpoint names across every public step operation", async () => {
    await expect(api().run("__host:workspace", () => ({}))).rejects.toThrow("reserved")
    await expect(api().waitForApproval("__host:publish", { title: "x" })).rejects.toThrow(
      "reserved"
    )
    await expect(api().waitForEvent("__host:session", { key: "x", timeoutMs: 1 })).rejects.toThrow(
      "reserved"
    )
  })
  it("is derived, so a re-entry finds the same pending decision", async () => {
    expect(await botApprovalInterruptId("run_1", "send")).toBe(
      await botApprovalInterruptId("run_1", "send")
    )
    expect(await botApprovalInterruptId("run_1", "send")).not.toBe(
      await botApprovalInterruptId("run_1", "other")
    )
  })
})

describe("step.run", () => {
  it("runs the function once and returns its value", async () => {
    const fn = jest.fn().mockResolvedValue({ issues: 2 })
    expect(await api().run("fetch", fn)).toEqual({ issues: 2 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("does not call the function again after a re-entry", async () => {
    const fn = jest.fn().mockResolvedValue("first")
    await api().run("fetch", fn)

    const second = jest.fn().mockResolvedValue("second")
    // This IS the resume: a fresh step API over the same run id.
    expect(await api().run("fetch", second)).toBe("first")
    expect(second).not.toHaveBeenCalled()
  })

  it("writes the timeline events without putting the output in them", async () => {
    await api().run("fetch", async () => ({ url: "https://api.github.com/x" }))

    const events = await runEventJournal.replay(RUN_ID)
    const types = events.map((e) => e.type)
    expect(types).toContain("step.started")
    expect(types).toContain("step.completed")
    // The journal redacts strings, so the value lives in the checkpoint store.
    expect(JSON.stringify(events)).not.toContain("api.github.com")
    expect(await getBotRunStep(RUN_ID, "fetch")).toMatchObject({
      output: { url: "https://api.github.com/x" },
    })
  })

  it("records a failure and rethrows, so the delivery can decide to retry", async () => {
    await expect(
      api().run("fetch", () => {
        throw new Error("upstream 500")
      })
    ).rejects.toThrow("upstream 500")

    expect(await getBotRunStep(RUN_ID, "fetch")).toMatchObject({
      status: "failed",
      error: "upstream 500",
    })
  })

  it("re-runs a failed step on the next entry", async () => {
    await api()
      .run("fetch", () => {
        throw new Error("boom")
      })
      .catch(() => undefined)

    const retry = jest.fn().mockResolvedValue("ok")
    expect(await api().run("fetch", retry)).toBe("ok")
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it("refuses to start a step once the run is cancelled", async () => {
    const controller = new AbortController()
    controller.abort()
    const fn = jest.fn()

    await expect(api(controller.signal).run("fetch", fn)).rejects.toThrow(BotRunCancelledError)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe("step.waitForApproval", () => {
  it("parks on a pending interrupt and resolves when a person answers", async () => {
    const pending = api().waitForApproval("send", { title: "Post the digest?" })

    const interruptId = await botApprovalInterruptId(RUN_ID, "send")
    const row = await waitForInterrupt(interruptId)
    expect(row.type).toBe("bot_approval")
    await getDb().executionRunInterrupts.put({
      ...row,
      status: "approved",
      resolvedAt: NOW + 10,
      resolvedBy: { displayName: "Ada" },
    })

    const decision = await pending
    expect(decision.outcome).toBe("approved")
    expect(decision.decidedBy?.displayName).toBe("Ada")
  })

  it("reports an expiry rather than treating silence as a yes", async () => {
    const decision = await api().waitForApproval("send", {
      title: "Post the digest?",
      timeoutMs: 1_000,
    })
    expect(decision.outcome).toBe("expired")
    expect(decision.decidedBy).toBeUndefined()
  })

  it("memoizes the decision, so a resumed handler does not ask twice", async () => {
    await api().waitForApproval("send", { title: "Post?", timeoutMs: 1_000 })
    const before = await getDb().executionRunInterrupts.count()

    const again = await api().waitForApproval("send", { title: "Post?", timeoutMs: 1_000 })
    expect(again.outcome).toBe("expired")
    expect(await getDb().executionRunInterrupts.count()).toBe(before)
  })

  it("does not restart the deadline on a re-entry", async () => {
    // Enter once and abandon the wait, the way a killed process would.
    const controller = new AbortController()
    const first = api(controller.signal)
      .waitForApproval("send", { title: "Post?", timeoutMs: 60_000 })
      .catch(() => undefined)
    const created = await waitForInterrupt(await botApprovalInterruptId(RUN_ID, "send"))
    controller.abort()
    await first

    const originalExpiry = created.expiresAt

    clock = NOW + 30_000
    const resumed = api()
      .waitForApproval("send", { title: "Post?", timeoutMs: 60_000 })
      .catch(() => undefined)
    const after = await waitForInterrupt(await botApprovalInterruptId(RUN_ID, "send"))
    // A wait that silently extends itself on every restart never ends.
    expect(after.expiresAt).toBe(originalExpiry)
    await getDb().executionRunInterrupts.put({ ...after, status: "denied", resolvedAt: clock })
    await resumed
  })
})

describe("step.waitForEvent", () => {
  it("returns the envelope when a correlated delivery arrives", async () => {
    await enqueueBotDelivery({ envelope: envelope("ci:run-42"), now: NOW })

    const result = await api().waitForEvent("ci", { key: "ci:run-42", timeoutMs: 10_000 })
    expect(result?.eventId).toBe("bev_ci")
  })

  it("resolves to null on timeout, because never arriving is an ordinary branch", async () => {
    expect(await api().waitForEvent("ci", { key: "ci:run-99", timeoutMs: 1_000 })).toBeNull()
  })

  it("memoizes a timeout, so a resumed handler does not wait again", async () => {
    await api().waitForEvent("ci", { key: "ci:run-99", timeoutMs: 1_000 })
    await enqueueBotDelivery({ envelope: envelope("ci:run-99"), now: NOW })

    // The wait already concluded. A late arrival does not un-conclude it.
    expect(await api().waitForEvent("ci", { key: "ci:run-99", timeoutMs: 1_000 })).toBeNull()
  })

  it("refuses to start once the run is cancelled", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      api(controller.signal).waitForEvent("ci", { key: "k", timeoutMs: 1_000 })
    ).rejects.toThrow(BotRunCancelledError)
  })
})

/**
 * `drainBotDeliveries` walks its batch in order, so a wait that polls in place
 * holds the pass open for its whole life. One Bot waiting on a human used to
 * stall every other Bot on the host until the approval TTL expired.
 */
describe("step waits park rather than holding the runner's pass", () => {
  it("parks an approval nobody has answered yet", async () => {
    const parked = await parkingApi()
      .waitForApproval("send", { title: "Post the digest?", timeoutMs: 60_000 })
      .catch((error: unknown) => error)

    expect(parked).toBeInstanceOf(BotRunParkedError)
    const error = parked as BotRunParkedError
    expect(error.stepName).toBe("send")
    expect(error.waitingFor).toBe(await botApprovalInterruptId(RUN_ID, "send"))
    expect(error.resumeAt).toBe(NOW + 20_000)
  })

  it("leaves the interrupt on somebody's screen while it is parked", async () => {
    await parkingApi()
      .waitForApproval("send", { title: "Post?", timeoutMs: 60_000 })
      .catch(() => undefined)

    const row = await getDb().executionRunInterrupts.get(
      await botApprovalInterruptId(RUN_ID, "send")
    )
    expect(row?.status).toBe("pending")
  })

  it("resumes on the decision when the handler is re-entered", async () => {
    await parkingApi()
      .waitForApproval("send", { title: "Post?", timeoutMs: 60_000 })
      .catch(() => undefined)

    const interruptId = await botApprovalInterruptId(RUN_ID, "send")
    const row = await getDb().executionRunInterrupts.get(interruptId)
    await getDb().executionRunInterrupts.put({
      ...row!,
      status: "approved",
      resolvedAt: NOW + 10,
      resolvedBy: { displayName: "Ada" },
    })

    const decision = await parkingApi().waitForApproval("send", {
      title: "Post?",
      timeoutMs: 60_000,
    })
    expect(decision.outcome).toBe("approved")
    expect(decision.decidedBy?.displayName).toBe("Ada")
  })

  it("never parks past its own deadline", async () => {
    // The wait expires sooner than the park interval, so coming back on the
    // interval would answer a question that had already timed out.
    const parked = await parkingApi()
      .waitForApproval("send", { title: "Post?", timeoutMs: 5_000 })
      .catch((error: unknown) => error as BotRunParkedError)

    expect((parked as BotRunParkedError).resumeAt).toBe(NOW + 5_000)
  })

  it("still reports an expiry rather than parking forever", async () => {
    await parkingApi()
      .waitForApproval("send", { title: "Post?", timeoutMs: 1_000 })
      .catch(() => undefined)
    clock = NOW + 5_000

    const decision = await parkingApi().waitForApproval("send", {
      title: "Post?",
      timeoutMs: 1_000,
    })
    expect(decision.outcome).toBe("expired")
    expect(decision.decidedBy).toBeUndefined()
  })

  it("parks a wait for an event that has not arrived", async () => {
    const parked = await parkingApi()
      .waitForEvent("ci", { key: "ci:run-42", timeoutMs: 60_000 })
      .catch((error: unknown) => error)

    expect(parked).toBeInstanceOf(BotRunParkedError)
    expect((parked as BotRunParkedError).waitingFor).toBe("ci:run-42")
  })

  it("returns the envelope on re-entry once the event lands", async () => {
    await parkingApi()
      .waitForEvent("ci", { key: "ci:run-42", timeoutMs: 60_000 })
      .catch(() => undefined)
    await enqueueBotDelivery({ envelope: envelope("ci:run-42"), now: NOW })

    const result = await parkingApi().waitForEvent("ci", {
      key: "ci:run-42",
      timeoutMs: 60_000,
    })
    expect(result?.eventId).toBe("bev_ci")
  })

  it("resolves to null once the event's own deadline passes", async () => {
    await parkingApi()
      .waitForEvent("ci", { key: "ci:run-42", timeoutMs: 1_000 })
      .catch(() => undefined)
    clock = NOW + 5_000

    expect(await parkingApi().waitForEvent("ci", { key: "ci:run-42", timeoutMs: 1_000 })).toBeNull()
  })
})

it("records and resolves an exact policy decision with host provenance through the shared interrupt journal", async () => {
  const request = {
    title: "Publish",
    decisionMode: "policy" as const,
    detail: { approvedAction: { actionId: "reviewPr", input: { body: "exact" } } },
  }
  const decision = await parkingApi().waitForApproval("policy", request)
  expect(decision).toMatchObject({
    outcome: "approved",
    decisionMode: "policy",
    decidedBy: { displayName: "Host policy" },
  })
  const row = await getDb().executionRunInterrupts.get(decision.approvalId!)
  expect(row).toMatchObject({
    approvalDetail: request.detail,
    approvalDecisionMode: "policy",
    approvalPolicy: { kind: "bot-installation", installationId: "boti_1" },
    status: "approved",
  })
  expect(row?.resolvedBy?.principalId).toBeUndefined()
  const events = await getDb().executionRunEvents.where("runId").equals(RUN_ID).toArray()
  expect(events.some((event) => event.type === "interrupt.resolved")).toBe(true)
  expect(await parkingApi().waitForApproval("policy", request)).toEqual(decision)
})

it("falls back to human review without authority and never converts a parked human approval", async () => {
  const request = { title: "Publish", decisionMode: "policy" as const, detail: { diff: "+safe" } }
  jest.mocked(resolveOwnedBotAuthority).mockResolvedValue({
    installation: { id: "boti_1" },
    automatedPublicationAllowed: false,
  } as never)
  await expect(parkingApi().waitForApproval("policy", request)).rejects.toBeInstanceOf(
    BotRunParkedError
  )
  const id = await botApprovalInterruptId(RUN_ID, "policy")
  expect((await getDb().executionRunInterrupts.get(id))?.approvalDecisionMode).toBe("human")
  jest.mocked(resolveOwnedBotAuthority).mockResolvedValue({
    installation: { id: "boti_1" },
    automatedPublicationAllowed: true,
  } as never)
  await expect(parkingApi().waitForApproval("policy", request)).rejects.toBeInstanceOf(
    BotRunParkedError
  )
  expect((await getDb().executionRunInterrupts.get(id))?.status).toBe("pending")
})

it("rechecks the grant before policy resolution, then respects denial, cancellation, expiry and mode tightening", async () => {
  const request = { title: "Publish", decisionMode: "policy" as const, timeoutMs: 5_000 }
  jest
    .mocked(resolveOwnedBotAuthority)
    .mockResolvedValueOnce({
      installation: { id: "boti_1" },
      automatedPublicationAllowed: true,
    } as never)
    .mockResolvedValueOnce({
      installation: { id: "boti_1" },
      automatedPublicationAllowed: false,
    } as never)
  await expect(parkingApi().waitForApproval("policy", request)).rejects.toBeInstanceOf(
    BotRunParkedError
  )
  const id = await botApprovalInterruptId(RUN_ID, "policy")
  await getDb().executionRunInterrupts.update(id, { status: "denied", resolvedAt: NOW })
  expect((await parkingApi().waitForApproval("policy", request)).outcome).toBe("denied")
  await expect(
    parkingApi().waitForApproval("policy", { ...request, decisionMode: "human" })
  ).rejects.toThrow("content changed")
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(
    parkingApi(cancelled.signal).waitForApproval("cancel", request)
  ).rejects.toBeInstanceOf(BotRunCancelledError)
  await expect(
    parkingApi().waitForApproval("invalid", { title: "x", decisionMode: "invalid" as never })
  ).rejects.toThrow("decision mode")
  const expiry = await parkingApi().waitForApproval("expired-policy", { ...request, timeoutMs: 0 })
  expect(expiry.outcome).toBe("expired")
})

it("authorizes a real installed Bot through the owner and policy stores inside the decision transaction", async () => {
  const { registerBot, unregisterBotsByPlugin } =
    await import("@/lib/plugin/registries/bot-registry")
  const { completeBotRunStep } = await import("@/lib/db/bot-run-steps")
  const realAuthority = jest.requireActual<typeof import("@/lib/bot/policy/run-authority")>(
    "@/lib/bot/policy/run-authority"
  )
  const grant = { maxAutonomy: "autopilot" as const, requireApprovalForWrites: false }
  registerBot(
    "publication",
    {
      id: "policy-plugin:publication",
      definition: {
        id: "publication",
        name: "Publication",
        version: "1.0.0",
        executor: "handler",
        triggers: [{ id: "manual", kind: "manual" }],
      },
      handler: async () => ({}),
    },
    { pluginId: "policy-plugin" }
  )
  try {
    await getDb().botInstallations.put({
      id: "boti_1",
      definitionId: "policy-plugin:publication",
      definitionSource: "plugin",
      pinnedVersion: "1.0.0",
      status: "enabled",
      scope: { kind: "account" },
      config: {},
      credentialBindings: {},
      policyGrant: grant,
      createdAt: NOW,
      updatedAt: NOW,
    })
    await completeBotRunStep(RUN_ID, "__host:policy", grant)
    jest.mocked(resolveOwnedBotAuthority).mockImplementation(realAuthority.resolveOwnedBotAuthority)
    const result = await parkingApi().waitForApproval("real-policy", {
      title: "Publish",
      decisionMode: "policy",
      detail: { approvedAction: { actionId: "reviewPr", input: { body: "exact" } } },
    })
    expect(result).toMatchObject({ outcome: "approved", decisionMode: "policy" })
  } finally {
    unregisterBotsByPlugin("policy-plugin")
  }
})
