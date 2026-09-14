/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { completeBotRunStep } from "@/lib/db/bot-run-steps"
import { createExecutionRun } from "@/lib/db/execution-runs"
import { enqueueBotDelivery } from "@/lib/db/bot-event-deliveries"
import { buildBotEventEnvelope } from "@/lib/bot/events/envelope"
const own = jest.fn()
const dispatch = jest.fn()
const endpoint = jest.fn()
jest.mock("@/lib/bot/runtime/owned-run", () => ({
  requireOwnedBotRun: (...args: unknown[]) => own(...args),
}))
jest.mock("@/lib/bot/events/dispatch", () => ({
  dispatchManualBotRun: (...args: unknown[]) => dispatch(...args),
}))
jest.mock("@/lib/db/integrations", () => ({
  getIntegrationIngressEndpoint: (...args: unknown[]) => endpoint(...args),
}))
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
