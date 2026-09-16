/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import type { PluginBotDef } from "@/types/plugin/plugin-bot"

import { installBot, getBotInstallation } from "@/lib/db/bot-installations"
import {
  enqueueBotDelivery,
  failBotDelivery,
  getBotDelivery,
  listBotDeliveries,
} from "@/lib/db/bot-event-deliveries"
import { runBotDelivery } from "@/lib/bot/runtime/run"
import { resolveInstalledBot } from "@/lib/bot/installed-bot"
import { buildBotEventEnvelope } from "@/lib/bot/events/envelope"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createExecutionRun, getExecutionRun } from "@/lib/db/execution-runs"
import { completeBotRunStep, getBotRunStep } from "@/lib/db/bot-run-steps"
import { __resetBotsForTesting, registerBot } from "@/lib/plugin/registries/bot-registry"

import {
  BotControlTargetMissingError,
  replayBotDeliveryLocally,
  runBotManuallyLocally,
  setBotTriggerArmedLocally,
} from "./local"

const NOW = 1_700_000_000_000

function def(overrides: Partial<PluginBotDef> = {}): PluginBotDef {
  return {
    id: "digest",
    name: "Digest",
    version: "1.0.0",
    executor: "handler",
    triggers: [
      { id: "run", kind: "manual" },
      { id: "nightly", kind: "schedule", cron: "0 9 * * *", enabledByDefault: false },
    ],
    ...overrides,
  } as PluginBotDef
}

async function install(definition: PluginBotDef = def(), overrides: Record<string, unknown> = {}) {
  registerBot("digest", { id: "acme:digest", definition, handler: jest.fn() }, { pluginId: "acme" })
  return installBot({
    definitionId: "acme:digest",
    definitionSource: "plugin",
    pinnedVersion: definition.version,
    scope: { kind: "account" },
    now: NOW,
    ...overrides,
  })
}

beforeEach(async () => {
  __resetBotsForTesting()
  await __resetDbForTesting()
})

describe("setBotTriggerArmedLocally", () => {
  it("keeps the first activation watermark across disable and rearm", async () => {
    const row = await install()
    const first = await setBotTriggerArmedLocally({
      installationId: row.id,
      triggerId: "nightly",
      armed: true,
    })
    expect(first.activatedAt).toBeGreaterThan(NOW)
    await setBotTriggerArmedLocally({ installationId: row.id, triggerId: "nightly", armed: false })
    const again = await setBotTriggerArmedLocally({
      installationId: row.id,
      triggerId: "nightly",
      armed: true,
    })
    expect(again.activatedAt).toBe(first.activatedAt)
  })
  it("writes an absolute value, so a replayed relay command cannot flip it back", () => {
    // arm, disarm, arm replayed in order lands on armed. Three toggles would
    // land on disarmed, which is why this is "set" and not "toggle".
    return install().then(async (row) => {
      await setBotTriggerArmedLocally({
        installationId: row.id,
        triggerId: "nightly",
        armed: true,
      })
      await setBotTriggerArmedLocally({
        installationId: row.id,
        triggerId: "nightly",
        armed: false,
      })
      const final = await setBotTriggerArmedLocally({
        installationId: row.id,
        triggerId: "nightly",
        armed: true,
      })
      expect(final.triggerOverrides?.nightly).toBe(true)
    })
  })

  it("refuses a trigger the definition does not declare", async () => {
    // An override for an unknown id is silently inert, which is the failure
    // this console exists to stop producing.
    const row = await install()
    await expect(
      setBotTriggerArmedLocally({ installationId: row.id, triggerId: "ghost", armed: true })
    ).rejects.toBeInstanceOf(BotControlTargetMissingError)
  })

  it("refuses an installation that is gone", async () => {
    await expect(
      setBotTriggerArmedLocally({ installationId: "boti_missing", triggerId: "run", armed: true })
    ).rejects.toBeInstanceOf(BotControlTargetMissingError)
  })

  it("keeps a needs_setup installation from silently becoming enabled", async () => {
    const row = await install(
      def({ requires: { credentials: [{ id: "token", label: "Token" }] } }),
      { requiredCredentials: [{ id: "token", label: "Token" }] }
    )
    expect(row.status).toBe("needs_setup")

    const next = await setBotTriggerArmedLocally({
      installationId: row.id,
      triggerId: "nightly",
      armed: true,
    })
    expect(next.status).toBe("needs_setup")
  })
})

describe("runBotManuallyLocally", () => {
  it("enqueues a delivery rather than running one, so the queue still serialises", async () => {
    const row = await install()
    const result = await runBotManuallyLocally({ installationId: row.id, idempotencyKey: "k1" })

    expect(result.created).toBe(true)
    const queued = await listBotDeliveries({ installationId: row.id })
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ status: "pending", triggerId: "run", type: "manual.run" })
  })

  it("folds a retried command onto one delivery", async () => {
    // The relay replays a queued command after a reconnect. Two runs need two
    // keys, and a retry of one needs the same key.
    const row = await install()
    await runBotManuallyLocally({ installationId: row.id, idempotencyKey: "k1" })
    await runBotManuallyLocally({ installationId: row.id, idempotencyKey: "k1" })
    expect(await listBotDeliveries({ installationId: row.id })).toHaveLength(1)

    await runBotManuallyLocally({ installationId: row.id, idempotencyKey: "k2" })
    expect(await listBotDeliveries({ installationId: row.id })).toHaveLength(2)
  })

  it("runs a DISARMED trigger, because pressing Run is the arming", async () => {
    const row = await install()
    const result = await runBotManuallyLocally({
      installationId: row.id,
      triggerId: "nightly",
      idempotencyKey: "k1",
    })
    expect(result.created).toBe(true)
    const [queued] = await listBotDeliveries({ installationId: row.id })
    expect(queued?.triggerId).toBe("nightly")
  })

  it("does not mark itself self-produced, or the loop guard would refuse it", async () => {
    const row = await install()
    await runBotManuallyLocally({ installationId: row.id, idempotencyKey: "k1" })
    const [queued] = await listBotDeliveries({ installationId: row.id })
    expect(queued?.envelope.provenance).toEqual({ selfProduced: false, depth: 0 })
    expect(queued?.envelope.actor).toEqual({ kind: "human" })
  })

  it("refuses when the definition declares no manual trigger and none was named", async () => {
    const row = await install(
      def({ triggers: [{ id: "nightly", kind: "schedule", cron: "* * * * *" }] })
    )
    await expect(
      runBotManuallyLocally({ installationId: row.id, idempotencyKey: "k1" })
    ).rejects.toBeInstanceOf(BotControlTargetMissingError)
  })

  it("carries the trigger's concurrency key, so it waits its turn", async () => {
    const row = await install(
      def({ triggers: [{ id: "run", kind: "manual", concurrencyKey: "{{type}}" }] })
    )
    await runBotManuallyLocally({ installationId: row.id, idempotencyKey: "k1" })
    const [queued] = await listBotDeliveries({ installationId: row.id })
    expect(queued?.concurrencyKey).toBe(`${row.id}::manual.run`)
  })
})

describe("replayBotDeliveryLocally", () => {
  async function deadLetter(installationId: string) {
    const envelope = buildBotEventEnvelope({
      source: "integration",
      sourceRecordId: "d7",
      type: "x",
      installationId,
      triggerId: "run",
      occurredAt: NOW,
      payload: {},
    })
    const row = await enqueueBotDelivery({ envelope, now: NOW })
    // Burn every attempt so the queue retires it.
    for (let i = 0; i < 12; i += 1) {
      const current = await getBotDelivery(row.id)
      if (current?.status === "deadletter") break
      await failBotDelivery(row.id, new Error("nope"), NOW)
    }
    return row.id
  }

  it("puts a dead-lettered delivery back on the queue", async () => {
    const install1 = await install()
    const id = await deadLetter(install1.id)
    expect((await getBotDelivery(id))?.status).toBe("deadletter")

    expect(await replayBotDeliveryLocally(id)).toBe(true)
    expect((await getBotDelivery(id))?.status).toBe("pending")
  })

  it("is a no-op the second time, which is what makes a replayed command safe", async () => {
    const install1 = await install()
    const id = await deadLetter(install1.id)
    await replayBotDeliveryLocally(id)
    expect(await replayBotDeliveryLocally(id)).toBe(false)
  })

  it.each(["failed", "cancelled"] as const)(
    "creates one fresh successor for a %s execution, preserving its artifacts and approvals",
    async (status) => {
      const installation = await install(
        def({
          triggers: [
            {
              id: "run",
              kind: "manual",
              concurrencyKey: "{{resource.scope}}",
              holdConcurrencyWhileWaiting: false,
            },
          ],
        })
      )
      const id = await deadLetter(installation.id)
      const original = (await getBotDelivery(id))!
      const runId = `recorded-${id}`
      await getDb().botEventDeliveries.update(id, {
        runId,
        status: "dismissed",
        envelope: {
          ...original.envelope,
          payload: { kind: "issue", mode: "implement", number: 25 },
          resource: { kind: "issue", id: "25", scope: "owner/repo" },
          binding: { integrationAccountId: "github" },
          correlation: "old-wait",
        },
      })
      await createExecutionRun({
        id: runId,
        kind: "bot",
        sourceId: installation.id,
        title: "Digest",
        status,
        currentRevision: 0,
        startedAt: NOW,
        updatedAt: NOW,
        endedAt: NOW,
      })
      await completeBotRunStep(runId, "completed-agent", { sessionId: "old-session" }, NOW)
      await completeBotRunStep(
        runId,
        "approval",
        { approved: true, approvalId: "old-approval" },
        NOW
      )
      const before = await getBotDelivery(id)
      const result = await Promise.all([replayBotDeliveryLocally(id), replayBotDeliveryLocally(id)])
      expect(result.sort()).toEqual([false, true])
      const rows = await listBotDeliveries({ installationId: installation.id })
      const successor = rows.find((candidate) => candidate.id !== id)!
      expect(rows).toHaveLength(2)
      expect(successor).toMatchObject({
        status: "pending",
        attempts: 0,
        source: original.source,
        type: original.type,
        concurrencyKey: `${installation.id}::owner/repo`,
        holdConcurrencyWhileWaiting: false,
        envelope: {
          payload: { kind: "issue", mode: "implement", number: 25 },
          binding: { integrationAccountId: "github" },
          actor: { kind: "human" },
          provenance: { causationEventIds: [original.eventId], selfProduced: false, depth: 0 },
        },
      })
      expect(successor.runId).toBeUndefined()
      expect(successor.envelope.correlation).toBeUndefined()
      expect(successor.envelope.eventId).not.toBe(original.eventId)
      expect(await getBotDelivery(id)).toEqual(before)
      expect((await getExecutionRun(runId))?.status).toBe(status)
      expect((await getBotRunStep(runId, "approval"))?.output).toEqual({
        approved: true,
        approvalId: "old-approval",
      })
      expect(await getBotRunStep(`run_bot_${successor.id}`, "approval")).toBeUndefined()
      expect(await replayBotDeliveryLocally(id)).toBe(false)
      await getDb().botEventDeliveries.update(successor.id, { status: "deadletter" })
      expect(await replayBotDeliveryLocally(successor.id)).toBe(true)
      expect(await listBotDeliveries({ installationId: installation.id })).toHaveLength(2)
    }
  )

  it.each([
    "delivery",
    "installation",
    "run",
    "disabled",
    "missing-definition",
    "missing-trigger",
    "missing-run",
  ])("refuses unsafe retry ownership or readiness: %s", async (failure) => {
    const installation = await install()
    const id = await deadLetter(installation.id)
    if (failure === "delivery")
      await getDb().botEventDeliveries.update(id, { syncedFromHost: true })
    if (failure === "installation")
      await getDb().botInstallations.update(installation.id, { syncedFromHost: true })
    if (failure === "disabled")
      await getDb().botInstallations.update(installation.id, { status: "disabled" })
    if (failure === "missing-definition") __resetBotsForTesting()
    if (failure === "missing-trigger")
      await getDb().botEventDeliveries.update(id, { triggerId: "removed" })
    if (failure === "run" || failure === "missing-run") {
      await getDb().botEventDeliveries.update(id, { runId: "foreign-run" })
      if (failure === "run")
        await createExecutionRun({
          id: "foreign-run",
          kind: "bot",
          sourceId: "other-installation",
          title: "Other",
          status: "failed",
          currentRevision: 0,
          startedAt: NOW,
          updatedAt: NOW,
        })
    }
    await expect(replayBotDeliveryLocally(id)).rejects.toThrow()
    expect(await listBotDeliveries({ installationId: installation.id })).toHaveLength(1)
    expect((await getBotDelivery(id))?.status).toBe("deadletter")
  })

  it("does not replay succeeded work or dismissals without an execution", async () => {
    const installation = await install()
    const id = await deadLetter(installation.id)
    await getDb().botEventDeliveries.update(id, { status: "dismissed" })
    expect(await replayBotDeliveryLocally(id)).toBe(false)
    await getDb().botEventDeliveries.update(id, { status: "deadletter", runId: "complete" })
    await createExecutionRun({
      id: "complete",
      kind: "bot",
      sourceId: installation.id,
      title: "Complete",
      status: "completed",
      currentRevision: 0,
      startedAt: NOW,
      updatedAt: NOW,
    })
    expect(await replayBotDeliveryLocally(id)).toBe(false)
  })

  it("executes a new run after a blocked result and lets a later failed successor retry independently", async () => {
    const installation = await install()
    const id = await deadLetter(installation.id)
    const original = (await getBotDelivery(id))!
    const resolved = (await resolveInstalledBot(installation))!
    const blocked = await runBotDelivery({
      delivery: original,
      resolved,
      executors: {
        handler: async () => ({ summary: "invalid_result_report", output: { status: "blocked" } }),
      },
    })
    expect(blocked.status).toBe("unavailable")
    expect(await replayBotDeliveryLocally(id)).toBe(true)
    const successor = (await listBotDeliveries({ installationId: installation.id })).find(
      (row) => row.id !== id
    )!
    const handler = jest.fn(async () => ({
      summary: "still blocked",
      output: { status: "blocked" },
    }))
    const second = await runBotDelivery({ delivery: successor, resolved, executors: { handler } })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(second.runId).not.toBe(blocked.runId)
    expect((await getExecutionRun(blocked.runId))?.status).toBe("failed")
    expect((await getExecutionRun(second.runId))?.status).toBe("failed")
    expect(await replayBotDeliveryLocally(id)).toBe(false)
    expect(await replayBotDeliveryLocally(successor.id)).toBe(true)
    const newest = (await listBotDeliveries({ installationId: installation.id })).find(
      (row) => row.status === "pending"
    )!
    const success = await runBotDelivery({
      delivery: newest,
      resolved,
      executors: { handler: async () => ({ summary: "recovered" }) },
    })
    expect(success.status).toBe("completed")
    expect((await getBotRunStep(blocked.runId, "__host:result"))?.output).toMatchObject({
      summary: "invalid_result_report",
    })
    expect(await listBotDeliveries({ installationId: installation.id })).toHaveLength(3)
  })

  it.each(["running", "waiting", "paused", "recovery_required"] as const)(
    "requeues a %s execution without replacing its recorded run or completed steps",
    async (status) => {
      const installation = await install()
      const id = await deadLetter(installation.id)
      const runId = `recorded-${id}`
      await getDb().botEventDeliveries.update(id, { runId })
      const run = await createExecutionRun({
        id: runId,
        kind: "bot",
        sourceId: installation.id,
        title: "Digest",
        status,
        currentRevision: 0,
        startedAt: NOW,
        updatedAt: NOW,
      })
      await completeBotRunStep(runId, "completed-agent", { sessionId: "recorded-session" }, NOW)
      expect(await replayBotDeliveryLocally(id)).toBe(true)
      expect(await getBotDelivery(id)).toMatchObject({ status: "pending", attempts: 0, runId })
      expect(await getExecutionRun(runId)).toEqual(run)
      expect(await getBotRunStep(runId, "completed-agent")).toMatchObject({
        output: { sessionId: "recorded-session" },
      })
    }
  )

  it("refuses a delivery that does not exist", async () => {
    await expect(replayBotDeliveryLocally("bdl_missing")).rejects.toBeInstanceOf(
      BotControlTargetMissingError
    )
  })
})

describe("installation reads", () => {
  it("leaves the row readable after every write", async () => {
    const row = await install()
    await setBotTriggerArmedLocally({ installationId: row.id, triggerId: "run", armed: false })
    expect((await getBotInstallation(row.id))?.triggerOverrides).toEqual({ run: false })
  })
})

describe("setBotTriggerArmedLocally lifecycle hook", () => {
  async function installWithHook(onArm: jest.Mock) {
    registerBot(
      "digest",
      {
        id: "acme:digest",
        definition: def(),
        handler: jest.fn(),
        lifecycle: { onArm },
      },
      { pluginId: "acme" }
    )
    return installBot({
      definitionId: "acme:digest",
      definitionSource: "plugin",
      pinnedVersion: "1.0.0",
      scope: { kind: "account" },
      now: NOW,
    })
  }

  it("invokes onArm with the trigger and the new armed state", async () => {
    const onArm = jest.fn()
    const row = await installWithHook(onArm)
    await setBotTriggerArmedLocally({ installationId: row.id, triggerId: "nightly", armed: true })
    expect(onArm).toHaveBeenCalledTimes(1)
    const ctx = onArm.mock.calls[0][0]
    expect(ctx.trigger).toEqual({ id: "nightly", armed: true })
    expect(ctx.installation.id).toBe(row.id)
  })

  it("fires for disarm too — a Bot turning itself off still sees onArm", async () => {
    const onArm = jest.fn()
    const row = await installWithHook(onArm)
    await setBotTriggerArmedLocally({ installationId: row.id, triggerId: "run", armed: false })
    expect(onArm).toHaveBeenCalledTimes(1)
    expect(onArm.mock.calls[0][0].trigger).toEqual({ id: "run", armed: false })
  })

  it("lets onArm veto: the override never lands", async () => {
    const onArm = jest.fn(() => Promise.reject(new Error("keep it disarmed")))
    const row = await installWithHook(onArm)
    await expect(
      setBotTriggerArmedLocally({ installationId: row.id, triggerId: "nightly", armed: true })
    ).rejects.toMatchObject({ name: "BotLifecycleHookError", phase: "onArm" })
    expect((await getBotInstallation(row.id))?.triggerOverrides).toBeUndefined()
  })
})
