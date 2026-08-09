/**
 * @jest-environment jsdom
 */
jest.mock("@/lib/db/seed", () => ({
  seedBuiltIns: jest.fn().mockResolvedValue(undefined),
}))

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  getBackgroundAgentManager,
  __resetBackgroundAgentManagerForTesting,
} from "./background-agent-manager"

const flush = () => new Promise((r) => setTimeout(r, 0))

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().backgroundTasks.clear()
  __resetBackgroundAgentManagerForTesting()
})

afterAll(dbFixture.dispose)

describe("BackgroundAgentManager facade", () => {
  it("registerAgent returns a live AbortSignal synchronously (legacy contract)", () => {
    const manager = getBackgroundAgentManager()
    const signal = manager.registerAgent("a1", { pluginId: "p1", label: "sweeper" })
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
    expect(manager.list()).toEqual([
      { id: "a1", startedAt: expect.any(Number), pluginId: "p1", label: "sweeper" },
    ])
  })

  it("journals a registered agent as a running plugin-agent row", async () => {
    const manager = getBackgroundAgentManager()
    manager.registerAgent("a1", { pluginId: "p1", label: "sweeper", prompt: "sweep the logs" })
    await flush()

    await expect(getDb().backgroundTasks.get("a1")).resolves.toMatchObject({
      kind: "plugin-agent",
      status: "running",
      pluginId: "p1",
      label: "sweeper",
      subagentId: "sweeper",
      prompt: "sweep the logs",
      host: "renderer",
      mode: "background",
    })
  })

  it("finishAgent settles the journal row done with the outcome text + usage", async () => {
    const manager = getBackgroundAgentManager()
    manager.registerAgent("a1", { pluginId: "p1" })

    expect(
      manager.finishAgent("a1", { text: "swept", usage: { inputTokens: 5, outputTokens: 2 } })
    ).toBe(true)
    await flush()

    await expect(getDb().backgroundTasks.get("a1")).resolves.toMatchObject({
      status: "done",
      resultText: "swept",
      usage: { inputTokens: 5, outputTokens: 2 },
    })
    expect(manager.list()).toEqual([])
  })

  it("finishAgent with an error settles the row as an error", async () => {
    const manager = getBackgroundAgentManager()
    manager.registerAgent("a1")

    manager.finishAgent("a1", { error: "exploded" })
    await flush()

    await expect(getDb().backgroundTasks.get("a1")).resolves.toMatchObject({
      status: "error",
      error: "exploded",
    })
  })

  it("double-finish is a settle-once no-op (backstop after an outcome settle)", async () => {
    const manager = getBackgroundAgentManager()
    manager.registerAgent("a1")

    expect(manager.finishAgent("a1", { text: "real outcome" })).toBe(true)
    expect(manager.finishAgent("a1")).toBe(false)
    await flush()

    await expect(getDb().backgroundTasks.get("a1")).resolves.toMatchObject({
      status: "done",
      resultText: "real outcome",
    })
  })

  it("finishAgent returns false for unknown agents (legacy contract)", () => {
    expect(getBackgroundAgentManager().finishAgent("ghost")).toBe(false)
  })

  it("cancelAgent aborts the signal and journals a cancelled error row", async () => {
    const manager = getBackgroundAgentManager()
    const signal = manager.registerAgent("a1", { pluginId: "p1" })

    expect(manager.cancelAgent("a1")).toBe(true)
    expect(signal.aborted).toBe(true)
    expect(manager.cancelAgent("a1")).toBe(false)
    await flush()

    await expect(getDb().backgroundTasks.get("a1")).resolves.toMatchObject({
      status: "error",
      error: "Cancelled.",
    })
  })

  it("cancelByPlugin aborts only that plugin's running agents", async () => {
    const manager = getBackgroundAgentManager()
    const s1 = manager.registerAgent("a1", { pluginId: "p1" })
    const s2 = manager.registerAgent("a2", { pluginId: "p2" })
    const s3 = manager.registerAgent("a3", { pluginId: "p1" })

    expect(manager.cancelByPlugin("p1")).toBe(2)
    expect(s1.aborted).toBe(true)
    expect(s3.aborted).toBe(true)
    expect(s2.aborted).toBe(false)
    expect(manager.list()).toEqual([expect.objectContaining({ id: "a2" })])
  })

  it("team delegations journal under the team-delegation kind", async () => {
    const manager = getBackgroundAgentManager()
    manager.registerAgent("d1", {
      kind: "team-delegation",
      label: "team-delegation:del-1",
      prompt: "summarize",
    })
    await flush()

    await expect(getDb().backgroundTasks.get("d1")).resolves.toMatchObject({
      kind: "team-delegation",
      label: "team-delegation:del-1",
    })
  })

  it("interrupted-on-boot reconciliation covers plugin-agent rows for free", async () => {
    const manager = getBackgroundAgentManager()
    manager.registerAgent("a1", { pluginId: "p1" })
    await flush()

    const { interruptBackgroundTasksOnBoot } = await import("@/lib/db/background-tasks")
    const flipped = await interruptBackgroundTasksOnBoot({ now: () => 9000 })

    expect(flipped).toEqual([
      expect.objectContaining({ runId: "a1", status: "interrupted", kind: "plugin-agent" }),
    ])
  })
})
