/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { installBot } from "@/lib/db/bot-installations"
import { listBotDeliveries } from "@/lib/db/bot-event-deliveries"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { __resetBotsForTesting, registerBot } from "@/lib/plugin/registries/bot-registry"
import type { PluginBotDef, PluginBotTriggerDef } from "@/types/plugin/plugin-bot"

import { dispatchWorkflowCompletedToBots, workflowEventType } from "./workflow-completed"

const NOW = 1_700_000_000_000

async function seed(trigger: PluginBotTriggerDef) {
  registerBot(
    "watch",
    {
      id: "acme:watch",
      definition: {
        id: "watch",
        name: "Watcher",
        version: "1.0.0",
        executor: "handler",
        triggers: [trigger],
      } as PluginBotDef,
      handler: jest.fn(),
    },
    { pluginId: "acme" }
  )
  return installBot({
    id: "boti_1",
    definitionId: "acme:watch",
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
    now: NOW,
  })
}

beforeEach(async () => {
  __resetDbForTesting()
  __resetBotsForTesting()
  await getDb().botInstallations.clear()
  await getDb().botEventDeliveries.clear()
}, 15_000)

const run = {
  workflowId: "wf_1",
  workflowName: "Nightly",
  runId: "wfr_1",
  status: "succeeded" as const,
}

describe("dispatchWorkflowCompletedToBots", () => {
  it("delivers to a trigger watching the matching terminal state", async () => {
    await seed({ id: "done", kind: "event", source: "workflow", types: ["workflow.succeeded"] })

    expect((await dispatchWorkflowCompletedToBots(run)).enqueued).toHaveLength(1)
  })

  it("does not deliver a success to a trigger watching failures", async () => {
    await seed({ id: "broke", kind: "event", source: "workflow", types: ["workflow.failed"] })

    expect((await dispatchWorkflowCompletedToBots(run)).enqueued).toEqual([])
  })

  it("is idempotent, because a re-emitted terminal state is the same event", async () => {
    await seed({ id: "done", kind: "event", source: "workflow", types: ["workflow.succeeded"] })
    await dispatchWorkflowCompletedToBots(run)
    await dispatchWorkflowCompletedToBots(run)

    expect(await listBotDeliveries({ installationId: "boti_1" })).toHaveLength(1)
  })

  it("is not self-produced, so the loop guard leaves it alone", async () => {
    await seed({ id: "done", kind: "event", source: "workflow", types: ["workflow.succeeded"] })
    await dispatchWorkflowCompletedToBots(run)

    const [row] = await listBotDeliveries({ installationId: "boti_1" })
    expect(row.envelope.provenance).toEqual({ selfProduced: false, depth: 0 })
  })

  it("names both terminal states", () => {
    expect(workflowEventType("succeeded")).toBe("workflow.succeeded")
    expect(workflowEventType("failed")).toBe("workflow.failed")
  })
})
