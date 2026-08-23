/**
 * Headless smoke for the boot-initializer batch (ADR-0059 T-A7..A9): every
 * registered runtime must start (and tear down) in a pure-Node process with
 * the fake-indexeddb shim — no DOM, no Tauri.
 *
 * @jest-environment node
 */
import { installFakeIndexedDb } from "../node-indexeddb"
import { bootstrapHeadlessRuntimes } from "../bootstrap"
import { __resetHeadlessRuntimesForTesting } from "../registry"
import type { HeadlessRuntimeContext, RuntimeBridge } from "../types"
import {
  getPluginTrigger,
  registerPluginTrigger,
  type TriggerRegistration,
} from "@/lib/workflow/triggers/registry"
import type { PluginTriggerDef } from "@/types/plugin/plugin-workflow"
import { createWorkflow } from "@/lib/db/workflows"
import { __resetDbForTesting, whenSeeded } from "@/lib/db/schema"
import { publishWorkflow } from "@/lib/workflow/publish/publish-workflow"
import { _waitForPluginTriggerReconciliationForTest } from "@/lib/workflow/triggers/lifecycle"

const EXPECTED = [
  "scheduler",
  "workflow-runtime",
  "agent-team-runtime",
  "external-agent",
  "ocr-runtime",
  "automation-policy",
  "audit-retention",
  "storage-retention",
  "template-trust-reconciliation",
  "desktop-network-runtime",
  "provider-core-runtime",
  "routing-runtime",
  "background-task",
  "provider-cost-mirror",
]

function makeCtx(): HeadlessRuntimeContext {
  const bridge: RuntimeBridge = {
    listen: async () => () => undefined,
    invoke: async () => null,
  }
  return {
    host: "brain",
    accountId: "local_acct_a",
    bridge,
    notifyDbWrite: () => undefined,
    resolveMessage: (key) => key,
    log: () => undefined,
  }
}

describe("initializer batch headless smoke", () => {
  it("starts and stops every batch runtime in Node", async () => {
    await installFakeIndexedDb()
    // schedulerDb captures Dexie's dependencies when its singleton is
    // constructed. Import it only after the Node shim is installed; a static
    // import here makes the smoke test report a started scheduler even though
    // its database initialization failed with MissingAPIError.
    const { schedulerDb } = await import("@/lib/scheduler/scheduler-db")
    // Production starts durability (including the full seed pass) before the
    // runtime batch. Mirror that ordering so the first workflow write cannot
    // race the skill/resource seeder inside Dexie's opening transaction.
    await whenSeeded()
    __resetHeadlessRuntimesForTesting()
    await import("./initializers")

    const result = await bootstrapHeadlessRuntimes(makeCtx())
    const failures = result.failed.map(
      (f) => `${f.name}: ${f.error instanceof Error ? f.error.message : String(f.error)}`
    )
    expect(failures).toEqual([])
    for (const name of EXPECTED) {
      expect(result.started).toContain(name)
    }
    const workflow = await createWorkflow({
      name: "Headless plugin trigger",
      nodes: [
        {
          id: "plugin-root",
          type: "trigger.headless.watch" as never,
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "Watch", params: { scope: "all" } },
        },
      ],
    })
    expect(workflow.id).toMatch(/^wf_/)
    await publishWorkflow(workflow.id, Date.now())
    const stop = jest.fn(async () => undefined)
    const start = jest.fn(async () => ({ stop }))
    const registration: TriggerRegistration = {
      kind: "trigger.headless.watch",
      typeVersion: 1,
      pluginId: "headless",
      def: {
        kind: "trigger.watch",
        typeVersion: 1,
        label: "Watch",
        description: "",
        iconName: "Radio",
        paramsSchema: { type: "object" },
        start,
      } as unknown as PluginTriggerDef,
      instances: new Map(),
    }

    registerPluginTrigger(registration)
    await Promise.resolve()
    await _waitForPluginTriggerReconciliationForTest()
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: workflow.id, triggerId: "plugin-root" })
    )

    await result.stop()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(getPluginTrigger("trigger.headless.watch", 1)?.instances.size).toBe(0)
    schedulerDb.close()
    __resetDbForTesting()
  }, 60_000)
})
