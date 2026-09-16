/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { completeBotRunStep } from "@/lib/db/bot-run-steps"
import { createExecutionRun } from "@/lib/db/execution-runs"
import { enqueueBotDelivery } from "@/lib/db/bot-event-deliveries"
import { buildBotEventEnvelope } from "@/lib/bot/events/envelope"
const own = jest.fn()
const dispatch = jest.fn()
const dispatchEvent = jest.fn()
const setArmed = jest.fn()
const endpoint = jest.fn()
const liveSignal = { current: undefined as AbortSignal | undefined }
jest.mock("@/lib/bot/runtime/owned-run", () => ({
  requireOwnedBotRun: (...args: unknown[]) => own(...args),
}))
jest.mock("@/lib/bot/events/dispatch", () => ({
  dispatchManualBotRun: (...args: unknown[]) => dispatch(...args),
  dispatchBotEvent: (...args: unknown[]) => dispatchEvent(...args),
}))
jest.mock("@/lib/bot/control-writes/local", () => ({
  setBotTriggerArmedLocally: (...args: unknown[]) => setArmed(...args),
}))
jest.mock("@/lib/db/integrations", () => ({
  getIntegrationIngressEndpoint: (...args: unknown[]) => endpoint(...args),
}))
jest.mock("@/lib/bot/runtime/run", () => ({
  ...jest.requireActual("@/lib/bot/runtime/run"),
  getLiveBotRunSignal: () => liveSignal.current,
}))
import { botApprovalInterruptId, BotRunParkedError } from "@/lib/bot/runtime/step"
import { pendingParks } from "@/lib/bot/runtime/host-step"
import { runEventJournal } from "@/lib/db/execution-runs"
import { createBotsAPI } from "./bots-api"

const installation = {
  id: "install",
  config: {},
  createdAt: 10,
  activatedAt: 20,
  credentialBindings: { github: { integrationAccountId: "account" } },
}
const resolved = {
  installation,
  definition: {
    id: "acme:digest",
    configSchema: { properties: { repository: { default: "owner/repo" } } },
    triggers: [{ id: "work", kind: "manual" }],
  },
}
beforeEach(async () => {
  __resetDbForTesting()
  const db = getDb()
  await Promise.all([
    db.botInstallations.clear(),
    db.botRunSteps.clear(),
    db.integrationSubscriptions.clear(),
    db.botEventDeliveries.clear(),
    db.executionRuns.clear(),
    db.executionRunInterrupts.clear(),
    db.executionRunEvents.clear(),
  ])
  await db.botInstallations.put(installation as never)
  own.mockResolvedValue({ installation, resolved })
  dispatch.mockResolvedValue({ id: "delivery" })
  endpoint.mockResolvedValue(undefined)
  liveSignal.current = new AbortController().signal
  pendingParks.clear()
})
it("requires permission and run ownership", async () => {
  await expect(createBotsAPI("p", () => false).getInstallation("run")).rejects.toThrow(
    "agent:control"
  )
  own.mockRejectedValue(new Error("not owned"))
  await expect(createBotsAPI("p", () => true).getInstallation("run")).rejects.toThrow("not owned")
})
it("returns defaults and only enabled bound webhook state", async () => {
  const api = createBotsAPI("p", () => true)
  expect(await api.getInstallation("run")).toMatchObject({
    config: { repository: "owner/repo" },
    webhookEnabled: false,
    activatedAt: 20,
  })
  await getDb().integrationSubscriptions.put({
    id: "sub",
    pluginId: "github-delivery",
    accountId: "account",
    enabled: true,
  } as never)
  endpoint.mockResolvedValue({ accountId: "account", enabled: true })
  expect((await api.getInstallation("run")).webhookEnabled).toBe(true)
})
it("queues only declared manual work with stable identity and correlation", async () => {
  const api = createBotsAPI("p", () => true)
  const input = {
    triggerId: "work",
    eventId: "repo:1:sha",
    type: "review",
    payload: {},
    resource: { id: "1", kind: "pr" },
    correlation: "ci",
  }
  expect(await api.enqueue("run", input)).toEqual({ deliveryId: "delivery" })
  expect(dispatch).toHaveBeenLastCalledWith(
    expect.objectContaining({
      envelope: expect.objectContaining({
        eventId: "bev_bot_repo:1:sha",
        correlation: "install::ci",
      }),
    })
  )
  await expect(api.enqueue("run", { ...input, triggerId: "undeclared" })).rejects.toThrow(
    "declared manual"
  )
  await expect(api.enqueue("run", { ...input, eventId: " " })).rejects.toThrow("identity")
})
it("merges monitor state and rejects invalid timestamps and removed installations", async () => {
  const api = createBotsAPI("p", () => true)
  await api.recordMonitor("run", { lastSuccessAt: 100, cursor: "next" })
  await api.recordMonitor("run", { lastError: "offline", retryAt: 200 })
  expect((await getDb().botInstallations.get("install"))?.monitor).toEqual({
    lastSuccessAt: 100,
    cursor: "next",
    lastError: "offline",
    retryAt: 200,
  })
  await api.recordMonitor(
    "run",
    JSON.parse(JSON.stringify({ lastSuccessAt: 300, lastError: undefined, retryAt: undefined }))
  )
  expect((await getDb().botInstallations.get("install"))?.monitor).toEqual({
    lastSuccessAt: 300,
    cursor: "next",
    lastError: undefined,
    retryAt: undefined,
  })
  await expect(api.recordMonitor("run", { retryAt: NaN })).rejects.toThrow("timestamp")
  await getDb().botInstallations.delete("install")
  await expect(api.recordMonitor("run", {})).rejects.toThrow("removed")
})
it("cancels obsolete resource runs and approval while preserving the current revision", async () => {
  const api = createBotsAPI("p", () => true)
  for (const revision of ["old", "current"]) {
    const envelope = buildBotEventEnvelope({
      source: "bot",
      sourceRecordId: revision,
      installationId: "install",
      triggerId: "work",
      type: "review",
      payload: {},
      resource: { id: "pr1", kind: "pr" },
      occurredAt: 1,
    })
    await enqueueBotDelivery({ envelope })
    await getDb().botEventDeliveries.update(envelope.deliveryId, { runId: revision })
    await createExecutionRun({
      id: revision,
      kind: "bot",
      status: "waiting",
      sourceId: "install",
      title: revision,
      startedAt: 1,
      updatedAt: 1,
      currentRevision: 0,
    })
  }
  await getDb().executionRunInterrupts.put({
    id: "approval",
    runId: "old",
    status: "pending",
    expiresAt: Date.now() + 1000,
  } as never)
  expect(await api.cancelResource("monitor", { resourceId: "pr1", exceptEventId: "current" })).toBe(
    1
  )
  expect((await getDb().executionRuns.get("old"))?.status).toBe("cancelled")
  expect((await getDb().executionRunInterrupts.get("approval"))?.status).toBe("expired")
  expect((await getDb().executionRuns.get("current"))?.status).toBe("waiting")
})

it("projects only owned, completed publication checkpoints with matching snapshots", async () => {
  const api = createBotsAPI("p", () => true)
  for (const name of [
    "valid",
    "foreign",
    "mirrored",
    "missing-run",
    "missing-snapshot",
    "invalid-sha",
    "running",
    "wrong-repo",
  ]) {
    const envelope = buildBotEventEnvelope({
      source: "bot",
      sourceRecordId: name,
      installationId: "install",
      triggerId: "work",
      type: "issue",
      payload: { kind: "issue", mode: "implement", number: 25 },
      occurredAt: 1,
    })
    const delivery = await enqueueBotDelivery({ envelope })
    await getDb().botEventDeliveries.update(delivery.id, {
      runId: name,
      ...(name === "mirrored" ? { syncedFromHost: true } : {}),
    })
    if (name !== "missing-run")
      await createExecutionRun({
        id: name,
        kind: "bot",
        sourceId: name === "foreign" ? "other" : "install",
        status: "completed",
        title: name,
        currentRevision: 0,
        startedAt: 1,
        updatedAt: 1,
      })
    if (name !== "missing-snapshot")
      await completeBotRunStep(name, `__host:snapshot:${name}`, {
        id: name,
        runId: name,
        diff: "must not leave host projection",
      })
    await completeBotRunStep(name, `__host:publication:${name}`, {
      snapshotId: name,
      repository: name === "wrong-repo" ? "other/repo" : "owner/repo",
      branch: `bot/${name}`,
      headSha: name === "invalid-sha" ? "invalid" : "a".repeat(40),
    })
    if (name === "running")
      await getDb().botRunSteps.update(`${name}::__host:publication:${name}`, { status: "running" })
  }
  own.mockResolvedValue({
    installation: { ...installation, config: { repository: "owner/repo" } },
    resolved,
  })
  const result = await api.getInstallation("monitor")
  expect(result.publications).toEqual([
    {
      sourceRunId: "valid",
      snapshotId: "valid",
      repository: "owner/repo",
      branch: "bot/valid",
      headSha: "a".repeat(40),
      sourcePayload: { kind: "issue", mode: "implement", number: 25 },
    },
  ])
  expect(JSON.stringify(result)).not.toContain("must not leave host projection")
})

it("pages past empty poll history without per-poll joins or losing resource-less publications", async () => {
  const db = getDb()
  const count = 1200
  await db.botRunSteps.bulkPut(
    Array.from({ length: count }, (_, index) => ({
      id: `000-poll-${index}::__host:result`,
      runId: `poll-${index}`,
      name: "__host:result",
      status: "completed",
      output: { status: "no_changes" },
    })) as never
  )
  await db.botEventDeliveries.bulkPut(
    Array.from({ length: count }, (_, index) => ({
      id: `poll-${index}`,
      dedupKey: `poll-${index}`,
      installationId: "install",
      runId: `poll-${index}`,
      status: "completed",
      updatedAt: Date.now(),
    })) as never
  )
  const envelope = buildBotEventEnvelope({
    source: "bot",
    sourceRecordId: "old-publisher",
    installationId: "install",
    triggerId: "publish",
    type: "scheduled-publication",
    occurredAt: 1,
    payload: { original: true },
  })
  const delivery = await enqueueBotDelivery({ envelope })
  await db.botEventDeliveries.update(delivery.id, { runId: "zzz-old-publisher", updatedAt: 1 })
  await createExecutionRun({
    id: "zzz-old-publisher",
    kind: "bot",
    sourceId: "install",
    status: "completed",
    title: "Old publication",
    currentRevision: 0,
    startedAt: 1,
    updatedAt: 1,
  })
  await completeBotRunStep("zzz-old-publisher", "__host:snapshot:snapshot", {
    id: "snapshot",
    runId: "zzz-old-publisher",
  })
  await completeBotRunStep("zzz-old-publisher", "__host:publication:snapshot", {
    snapshotId: "snapshot",
    repository: "owner/repo",
    branch: "bot/old",
    headSha: "b".repeat(40),
  })
  const readRun = jest.spyOn(db.executionRuns, "get")
  const readDelivery = jest.spyOn(db.botEventDeliveries, "where")
  const readCheckpoints = jest.spyOn(db.botRunSteps, "bulkGet")
  try {
    const result = await createBotsAPI("p", () => true).getInstallation("monitor")
    expect(result.publications).toEqual([
      expect.objectContaining({
        sourceRunId: "zzz-old-publisher",
        sourcePayload: { original: true },
      }),
    ])
    expect(readRun).toHaveBeenCalledTimes(1)
    expect(readRun).toHaveBeenCalledWith("zzz-old-publisher")
    expect(readDelivery).toHaveBeenCalledTimes(1)
    expect(readDelivery).toHaveBeenCalledWith("runId")
    expect(readCheckpoints.mock.calls.flatMap(([keys]) => keys)).toEqual([
      "zzz-old-publisher::__host:publication:snapshot",
    ])
  } finally {
    readRun.mockRestore()
    readDelivery.mockRestore()
    readCheckpoints.mockRestore()
  }
})

describe("cross-process step parity", () => {
  async function seedRun(runId = "run") {
    await createExecutionRun({
      id: runId,
      kind: "bot",
      sourceId: "install",
      status: "running",
      title: "Digest",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
  }

  it("rejects every step method without permission, ownership, or liveness", async () => {
    await expect(createBotsAPI("p", () => false).stepBegin("run", "s")).rejects.toThrow(
      "agent:control"
    )
    own.mockRejectedValueOnce(new Error("not owned"))
    await expect(createBotsAPI("p", () => true).stepBegin("run", "s")).rejects.toThrow("not owned")
    liveSignal.current = undefined
    await expect(createBotsAPI("p", () => true).stepBegin("run", "s")).rejects.toThrow(
      "not executing on this host"
    )
  })

  it("begins a step, memoizes it on re-entry, and journals the host call", async () => {
    await seedRun()
    const api = createBotsAPI("p", () => true)
    expect(await api.stepBegin("run", "fetch")).toEqual({ memoized: false, attempt: 1 })
    await api.stepComplete("run", "fetch", { items: 3 })
    expect(await api.stepBegin("run", "fetch")).toEqual({
      memoized: true,
      value: { items: 3 },
    })
    const events = await runEventJournal.replay("run")
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["step.started", "step.completed"])
    )
    expect(events.find((event) => event.type === "step.started")?.payload).toMatchObject({
      via: "host-call",
    })
  })

  it("rejects a reserved or empty step name", async () => {
    const api = createBotsAPI("p", () => true)
    await expect(api.stepBegin("run", "__host:result")).rejects.toThrow("reserved")
    await expect(api.stepBegin("run", " ")).rejects.toThrow("empty")
  })

  it("stepComplete is idempotent for an equal value and refuses drift", async () => {
    await seedRun()
    const api = createBotsAPI("p", () => true)
    await api.stepBegin("run", "fetch")
    await api.stepComplete("run", "fetch", { a: 1, b: [2] })
    // Canonically equal (key order differs) — a re-entry write, not drift.
    await api.stepComplete("run", "fetch", { b: [2], a: 1 })
    await expect(api.stepComplete("run", "fetch", { a: 1, b: [3] })).rejects.toThrow(
      "Bot step value changed"
    )
  })

  it("stepComplete and stepFail refuse a step that was never begun", async () => {
    const api = createBotsAPI("p", () => true)
    await expect(api.stepComplete("run", "ghost", 1)).rejects.toThrow("not begun")
    await expect(api.stepFail("run", "ghost", "x")).rejects.toThrow("not begun")
  })

  it("stepFail records the failure and journals it", async () => {
    await seedRun()
    const api = createBotsAPI("p", () => true)
    await api.stepBegin("run", "fetch")
    await api.stepFail("run", "fetch", "upstream 500")
    expect((await getDb().botRunSteps.get("run::fetch"))?.status).toBe("failed")
    const events = await runEventJournal.replay("run")
    expect(events.find((event) => event.type === "step.failed")?.payload).toMatchObject({
      error: "upstream 500",
      via: "host-call",
    })
  })

  it("rejects the next host call once the run is cancelled", async () => {
    const controller = new AbortController()
    controller.abort()
    liveSignal.current = controller.signal
    const api = createBotsAPI("p", () => true)
    await expect(api.stepBegin("run", "fetch")).rejects.toThrow("cancelled")
  })

  it("waitForApproval parks, records the pending park, and reports its shape", async () => {
    await seedRun()
    const api = createBotsAPI("p", () => true)
    const outcome = await api.waitForApproval("run", "publish", {
      title: "Publish?",
      timeoutMs: 60_000,
    })
    expect(outcome.status).toBe("parked")
    expect(outcome).toMatchObject({ stepName: "publish" })
    const parked = pendingParks.get("run")
    expect(parked).toBeInstanceOf(BotRunParkedError)
    expect(parked?.stepName).toBe("publish")
    expect(parked?.resumeAt).toBe(outcome.status === "parked" ? outcome.resumeAt : -1)
    expect(await getDb().executionRunInterrupts.count()).toBe(1)
  })

  it("waitForApproval settles on an existing decision and uses the project scope", async () => {
    await seedRun()
    own.mockResolvedValue({
      installation: { ...installation, projectId: "proj-1" },
      resolved,
    })
    const interruptId = await botApprovalInterruptId("run", "publish")
    await getDb().executionRunInterrupts.put({
      id: interruptId,
      runId: "run",
      status: "approved",
      title: "Publish?",
      resolvedAt: 50,
      resolvedBy: { displayName: "Ada" },
    } as never)
    const api = createBotsAPI("p", () => true)
    const outcome = await api.waitForApproval("run", "publish", { title: "Publish?" })
    expect(outcome).toEqual({
      status: "settled",
      value: expect.objectContaining({ outcome: "approved", decidedAt: 50 }),
    })
    expect(pendingParks.get("run")).toBeUndefined()
  })

  it("waitForEvent parks while nothing is correlated and settles on a match", async () => {
    await seedRun()
    const api = createBotsAPI("p", () => true)
    const parked = await api.waitForEvent("run", "ci", { key: "key-1", timeoutMs: 60_000 })
    expect(parked.status).toBe("parked")
    expect(parked).toMatchObject({ stepName: "ci", waitingFor: "key-1" })
    expect(pendingParks.get("run")).toBeInstanceOf(BotRunParkedError)

    pendingParks.clear()
    const envelope = buildBotEventEnvelope({
      source: "integration",
      sourceRecordId: "e9",
      installationId: "install",
      triggerId: "work",
      type: "check_run.completed",
      payload: {},
      occurredAt: 1,
    })
    envelope.correlation = "key-1"
    await enqueueBotDelivery({ envelope })
    const settled = await api.waitForEvent("run", "ci", { key: "key-1", timeoutMs: 60_000 })
    expect(settled).toEqual({ status: "settled", value: envelope })
    expect(pendingParks.get("run")).toBeUndefined()
  })

  it("log validates the level and journals the line", async () => {
    await seedRun()
    const api = createBotsAPI("p", () => true)
    await expect(api.log("run", "verbose" as never, "x")).rejects.toThrow("log level")
    await api.log("run", "info", "fetched", { count: 3 })
    await api.log("run", "error", "broken")
    await new Promise((resolve) => setTimeout(resolve, 10))
    const types = (await runEventJournal.replay("run")).map((event) => event.type)
    expect(types).toEqual(expect.arrayContaining(["step.progress", "step.failed"]))
  })

  it("progress validates the fraction and journals the update", async () => {
    await seedRun()
    const api = createBotsAPI("p", () => true)
    for (const fraction of [Number.NaN, -0.1, 1.1, Number.POSITIVE_INFINITY]) {
      await expect(api.progress("run", { fraction })).rejects.toThrow("fraction")
    }
    await api.progress("run", { fraction: 0.5, message: "halfway" })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const events = await runEventJournal.replay("run")
    expect(events.find((event) => event.type === "step.progress")?.payload).toMatchObject({
      message: "halfway",
    })
  })
})

describe("plane read/write", () => {
  it("projects definition, scope, armed triggers, and bound slots without leaking ids", async () => {
    const richInstallation = {
      ...installation,
      definitionId: "acme:digest",
      pinnedVersion: "1.2.0",
      status: "enabled",
      scope: { kind: "workspace", workspaceId: "ws-1" },
      triggerOverrides: { poll: false },
      credentialBindings: {
        github: { integrationAccountId: "acct-secret-1" },
        slack: {},
      },
    }
    own.mockResolvedValue({
      installation: richInstallation,
      resolved: {
        installation: richInstallation,
        definition: {
          ...resolved.definition,
          triggers: [
            { id: "work", kind: "manual" },
            { id: "poll", kind: "poll", everyMs: 60_000 },
            { id: "quiet", kind: "poll", everyMs: 60_000, enabledByDefault: false },
          ],
          requires: {
            credentials: [
              { id: "github", label: "GitHub" },
              { id: "slack", label: "Slack", optional: true },
              { id: "jira", label: "Jira" },
            ],
          },
        },
      },
    })
    const snapshot = await createBotsAPI("acme", () => true).getInstallation("run")
    expect(snapshot).toMatchObject({
      definitionId: "acme:digest",
      pinnedVersion: "1.2.0",
      status: "enabled",
      scope: { kind: "workspace", workspaceId: "ws-1" },
      triggers: [
        // No override and no default means armed.
        { id: "work", kind: "manual", armed: true },
        { id: "poll", kind: "poll", armed: false },
        { id: "quiet", kind: "poll", armed: false },
      ],
      credentialSlots: [
        { id: "github", optional: false, bound: true },
        { id: "slack", optional: true, bound: false },
        { id: "jira", optional: false, bound: false },
      ],
    })
    expect(JSON.stringify(snapshot)).not.toContain("acct-secret-1")
  })

  it("writeTriggerState merges only cursor/watermark into a poll trigger", async () => {
    const richResolved = {
      installation,
      definition: {
        ...resolved.definition,
        triggers: [
          { id: "work", kind: "manual" },
          { id: "poll", kind: "poll", everyMs: 60_000 },
          { id: "edge", kind: "derivedState", everyMs: 60_000, state: "open" },
        ],
      },
    }
    own.mockResolvedValue({ installation, resolved: richResolved })
    const api = createBotsAPI("p", () => true)
    await api.writeTriggerState("run", { triggerId: "poll", cursor: "c-9", watermark: 41 })
    expect((await getDb().botInstallations.get("install"))?.triggerState?.poll).toEqual({
      cursor: "c-9",
      watermark: 41,
    })
    await api.writeTriggerState("run", { triggerId: "edge", watermark: 7 })
    expect((await getDb().botInstallations.get("install"))?.triggerState?.edge).toEqual({
      watermark: 7,
    })
  })

  it("writeTriggerState refuses unknown, non-stateful, and out-of-whitelist input", async () => {
    const api = createBotsAPI("p", () => true)
    await expect(api.writeTriggerState("run", { triggerId: "ghost" })).rejects.toThrow(
      "does not carry host-stored state"
    )
    await expect(api.writeTriggerState("run", { triggerId: "work", cursor: "c" })).rejects.toThrow(
      "does not carry host-stored state"
    )
    const richResolved = {
      installation,
      definition: {
        ...resolved.definition,
        triggers: [{ id: "poll", kind: "poll", everyMs: 60_000 }],
      },
    }
    own.mockResolvedValue({ installation, resolved: richResolved })
    await expect(
      api.writeTriggerState("run", {
        triggerId: "poll",
        lastEdgeValue: true,
      } as never)
    ).rejects.toThrow("Only cursor and watermark")
    await expect(
      api.writeTriggerState("run", { triggerId: "poll", cursor: "x".repeat(4097) })
    ).rejects.toThrow("cursor")
    await expect(
      api.writeTriggerState("run", { triggerId: "poll", watermark: Number.NaN })
    ).rejects.toThrow("watermark")
  })

  it("setTriggerArmed delegates to the local control write", async () => {
    const api = createBotsAPI("p", () => true)
    await api.setTriggerArmed("run", { triggerId: "poll", armed: false })
    expect(setArmed).toHaveBeenCalledWith({
      installationId: "install",
      triggerId: "poll",
      armed: false,
    })
    await expect(
      api.setTriggerArmed("run", { triggerId: "poll", armed: "yes" as never })
    ).rejects.toThrow("boolean")
  })

  it("listDeliveries filters, orders newest first, clamps the limit, and hides payloads", async () => {
    const db = getDb()
    const make = async (id: string, patch: Record<string, unknown>) => {
      const envelope = buildBotEventEnvelope({
        source: "integration",
        sourceRecordId: id,
        installationId: "install",
        triggerId: (patch.triggerId as string) ?? "poll",
        type: "check_run.completed",
        payload: { hidden: true },
        occurredAt: 1,
        resource: { kind: "repo", id: (patch.resourceId as string) ?? "r-1" },
      })
      const delivery = await enqueueBotDelivery({ envelope })
      await db.botEventDeliveries.update(delivery.id, {
        receivedAt: patch.receivedAt ?? 1,
        status: patch.status ?? "pending",
        ...(patch.synced ? { syncedFromHost: true } : {}),
      } as never)
      return delivery.id
    }
    await make("a", { receivedAt: 1 })
    await make("b", { receivedAt: 3, resourceId: "r-2" })
    await make("c", { receivedAt: 2, status: "failed" })
    await make("d", { receivedAt: 4, synced: true })

    const api = createBotsAPI("p", () => true)
    const all = await api.listDeliveries("run")
    // The mirrored row is excluded; order is receivedAt desc.
    expect(all.map((row) => row.eventId)).toEqual([
      "bev_integration_b",
      "bev_integration_c",
      "bev_integration_a",
    ])
    expect(JSON.stringify(all)).not.toContain("hidden")
    expect(all[0]).not.toHaveProperty("payload")

    expect(await api.listDeliveries("run", { resourceId: "r-2" })).toHaveLength(1)
    expect(await api.listDeliveries("run", { status: ["failed"] })).toHaveLength(1)
    expect(await api.listDeliveries("run", { triggerId: "ghost" })).toHaveLength(0)
    expect(await api.listDeliveries("run", { limit: 2 })).toHaveLength(2)
    expect(await api.listDeliveries("run", { limit: 999 })).toHaveLength(3)
    expect(await api.listDeliveries("run", { limit: 0 })).toHaveLength(1)
  })

  it("getRunResult returns own results and null for foreign or missing runs", async () => {
    await createExecutionRun({
      id: "sibling",
      kind: "bot",
      sourceId: "install",
      status: "completed",
      title: "Sibling",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    await completeBotRunStep("sibling", "__host:result", {
      summary: "3 reviews",
      output: { prs: [1, 2, 3] },
    })
    await createExecutionRun({
      id: "foreign",
      kind: "bot",
      sourceId: "other-install",
      status: "completed",
      title: "Foreign",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    await createExecutionRun({
      id: "bare",
      kind: "bot",
      sourceId: "install",
      status: "failed",
      title: "Bare",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    const api = createBotsAPI("p", () => true)
    expect(await api.getRunResult("run", { runId: "sibling" })).toEqual({
      status: "completed",
      summary: "3 reviews",
      output: { prs: [1, 2, 3] },
    })
    expect(await api.getRunResult("run", { runId: "foreign" })).toBeNull()
    expect(await api.getRunResult("run", { runId: "missing" })).toBeNull()
    expect(await api.getRunResult("run", { runId: "bare" })).toEqual({ status: "failed" })
  })

  it("emit rejects types outside the plugin namespace and oversized payloads", async () => {
    const api = createBotsAPI("acme.bot", () => true)
    await expect(api.emit("run", { type: "other.thing", payload: {} })).rejects.toThrow(
      "namespaced by the plugin id"
    )
    await expect(
      api.emit("run", { type: "acme.bot.x", payload: "y".repeat(70 * 1024) })
    ).rejects.toThrow("exceeds 65536 bytes")
    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it("emit chains provenance from the cause, dedupes on a derived id, and journals", async () => {
    const cause = buildBotEventEnvelope({
      source: "integration",
      sourceRecordId: "cause-1",
      installationId: "install",
      triggerId: "poll",
      type: "check_run.completed",
      payload: {},
      occurredAt: 1,
      provenance: { depth: 2 },
    })
    const delivery = await enqueueBotDelivery({ envelope: cause })
    await getDb().botEventDeliveries.update(delivery.id, { runId: "run" })
    await createExecutionRun({
      id: "run",
      kind: "bot",
      sourceId: "install",
      status: "running",
      title: "Emitter",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    dispatchEvent.mockResolvedValue({ enqueued: [{ id: "d1" }, { id: "d2" }] })

    const api = createBotsAPI("acme.bot", () => true)
    const first = await api.emit("run", {
      type: "acme.bot.review.ready",
      payload: { pr: 7 },
      resource: { kind: "pr", id: "7" },
    })
    expect(first).toEqual({ matchedInstallations: 2 })
    const envelope = dispatchEvent.mock.calls[0][0].envelope
    expect(envelope.provenance).toMatchObject({
      selfProduced: true,
      producedByRunId: "run",
      producedByInstallationId: "install",
      depth: 3,
      causationEventIds: [cause.eventId],
    })
    expect(envelope.actor).toEqual({ kind: "bot", id: "acme:digest" })
    expect(envelope.resource).toEqual({ kind: "pr", id: "7" })
    // Routing fields stay unset; the router owns them.
    expect(envelope).not.toHaveProperty("installationId")
    expect(envelope).not.toHaveProperty("triggerId")
    expect(envelope).not.toHaveProperty("deliveryId")
    expect(dispatchEvent.mock.calls[0][0].query).toEqual({
      source: "bot",
      type: "acme.bot.review.ready",
    })

    dispatchEvent.mockClear()
    await api.emit("run", { type: "acme.bot.review.ready", payload: { pr: 7 } })
    expect(dispatchEvent.mock.calls[0][0].envelope.eventId).toBe(envelope.eventId)

    await new Promise((resolve) => setTimeout(resolve, 10))
    const progress = (await runEventJournal.replay("run")).find(
      (event) => event.type === "step.progress"
    )
    expect(progress?.payload).toMatchObject({
      emitted: "acme.bot.review.ready",
      matched: 2,
    })
  })

  it("emit refuses a run with no delivery to chain from", async () => {
    const api = createBotsAPI("acme.bot", () => true)
    await expect(api.emit("run", { type: "acme.bot.x", payload: {} })).rejects.toThrow(
      "no delivery"
    )
  })
})
