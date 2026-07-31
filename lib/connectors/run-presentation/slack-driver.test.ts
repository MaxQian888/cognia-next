import { createSlackRunPresentationDriver } from "./slack-driver"
import type { RunProjectionSnapshot } from "@/types/execution/run"

const deliveryTarget = {
  address: {
    conversationKey: "slack:slack-1:C1",
    platform: "slack" as const,
    adapterId: "slack-1",
    scopeKind: "thread" as const,
    containerId: "C1",
    topicId: "111.2",
  },
  conversationRef: { platform: "slack" as const, adapterId: "slack-1", channelId: "C1" },
  sourceMessageId: "111.2",
  refreshedAt: 1,
}

function snapshot(kind: RunProjectionSnapshot["kind"]): RunProjectionSnapshot {
  return {
    runId: "run-1",
    kind,
    title: "Research plan",
    status: "running",
    revision: 1,
    startedAt: 1,
    updatedAt: 2,
    progress: { completed: 0, total: 1, trustworthy: kind === "workflow" },
    activeSteps: [{ id: "step-1", title: "x".repeat(300), status: "in_progress" }],
    recentSteps: [],
    pendingSteps: [],
    pendingStepCount: 0,
    elapsedMs: 1_000,
    artifacts: [],
    allowedActions: ["stop"],
    activities: Array.from({ length: 14 }, (_, index) => ({
      id: `tool:${index}`,
      kind: "tool" as const,
      category: index === 0 ? ("read" as const) : ("integration" as const),
      status: index === 0 ? ("running" as const) : ("completed" as const),
      label: index === 0 ? "Read" : `Tool ${index}`,
      ...(index === 0
        ? { target: { kind: "workspace_path" as const, label: "src/index.ts" } }
        : {}),
      startedAt: index,
      ...(index === 0 ? {} : { endedAt: index + 1 }),
    })),
    activityCount: 14,
    omittedActivityCount: 2,
  }
}

describe("Slack run presentation driver", () => {
  it("uses plan mode for workflows and clamps task chunks to 256 characters", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = []
    const driver = createSlackRunPresentationDriver(async (_method, path, body) => {
      calls.push({ path, body: body as Record<string, unknown> })
      return { ok: true, ts: "123.4" }
    })

    const ref = await driver.open(
      {
        adapterId: "slack-1",
        conversationKey: "slack:slack-1:C1",
        sourceMessageId: "111.2",
        deliveryTarget,
        recipientUserId: "U1",
        recipientTeamId: "T1",
      },
      snapshot("workflow")
    )
    await driver.update(ref, { ...snapshot("workflow"), revision: 2 })
    await driver.finish(ref, { ...snapshot("workflow"), revision: 3, status: "completed" })

    expect(calls.map((call) => call.path)).toEqual([
      "chat.startStream",
      "chat.appendStream",
      "chat.stopStream",
    ])
    expect(calls[0].body.task_display_mode).toBe("plan")
    const chunks = calls[0].body.chunks as Array<{ title?: string }>
    expect(Math.max(...chunks.map((chunk) => chunk.title?.length ?? 0))).toBeLessThanOrEqual(256)
    const tasks = chunks.filter((chunk) => (chunk as { type?: string }).type === "task_update")
    expect(tasks).toHaveLength(12)
    expect(tasks[0]).toEqual(
      expect.objectContaining({
        id: "tool:0",
        title: "Read",
        status: "in_progress",
        details: "src/index.ts",
      })
    )
    expect(ref.platformMessageId).toBe("C1:123.4")
    expect(calls[2].body.markdown_text).toContain("Task completed")
  })

  it("uses timeline mode for dynamic agent runs and requires an initiating message", async () => {
    const driver = createSlackRunPresentationDriver(async () => ({ ok: true, ts: "1" }))
    await expect(
      driver.open(
        { adapterId: "slack-1", conversationKey: "slack:slack-1:C1" },
        snapshot("agent-turn")
      )
    ).rejects.toThrow("sourceMessageId")

    let mode: unknown
    const timeline = createSlackRunPresentationDriver(async (_method, _path, body) => {
      mode = (body as { task_display_mode: unknown }).task_display_mode
      return { ok: true, ts: "1" }
    })
    await timeline.open(
      {
        adapterId: "slack-1",
        conversationKey: "slack:slack-1:C1",
        sourceMessageId: "0.1",
        deliveryTarget,
      },
      snapshot("agent-turn")
    )
    expect(mode).toBe("timeline")
  })

  it("uses timeline mode when a workflow has no trustworthy structured plan", async () => {
    let mode: unknown
    const driver = createSlackRunPresentationDriver(async (_method, _path, body) => {
      mode = (body as { task_display_mode: unknown }).task_display_mode
      return { ok: true, ts: "1" }
    })

    await driver.open(
      {
        adapterId: "slack-1",
        conversationKey: "slack:slack-1:C1",
        sourceMessageId: "0.1",
        deliveryTarget,
      },
      {
        ...snapshot("workflow"),
        progress: { completed: 0, total: 0, trustworthy: false },
      }
    )

    expect(mode).toBe("timeline")
  })
})
