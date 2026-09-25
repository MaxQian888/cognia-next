import {
  attentionRank,
  deriveAttention,
  itemAttention,
  signalsForItem,
  type AttentionInput,
} from "./attention"
import type { ScheduledTask } from "@/types/scheduler"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

function item(
  kind: UnifiedScheduledItem["kind"],
  sourceId: string,
  extra: Partial<UnifiedScheduledItem> = {}
): UnifiedScheduledItem {
  return {
    unifiedId: `${kind}:${sourceId}`,
    kind,
    sourceId,
    name: sourceId,
    status: "active",
    triggerSummary: { type: "cron", cron: "* * * * *" },
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
    ...extra,
  }
}

function task(id: string, extra: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id,
    name: id,
    type: "chat",
    status: "active",
    trigger: { type: "cron", cron: "* * * * *" },
    payload: { type: "chat", prompt: "x" },
    config: {},
    notification: {
      channels: [],
      onStart: false,
      onComplete: false,
      onError: false,
      onProgress: false,
    },
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...extra,
  } as ScheduledTask
}

function run(
  itemUnifiedId: string,
  status: UnifiedExecutionRun["status"],
  startedAt: number
): UnifiedExecutionRun {
  return {
    unifiedId: `${itemUnifiedId}:run:${startedAt}`,
    kind: itemUnifiedId.split(":")[0] as UnifiedExecutionRun["kind"],
    itemUnifiedId,
    itemName: itemUnifiedId,
    status,
    startedAt,
    origin: { tableName: "t", nativeId: String(startedAt) },
  }
}

const supported = () => ({ supported: true, missing: [], requires: [] })
const desktopOnly = () => ({
  supported: false,
  reason: "desktop-only" as const,
  missing: ["desktop-shell" as const],
  requires: ["desktop-shell" as const],
})

function input(over: Partial<AttentionInput> = {}): AttentionInput {
  return {
    items: [],
    tasksById: new Map(),
    runs: [],
    pendingConfirmations: 0,
    hostSuspended: false,
    sourceErrors: {},
    maxTasksPerSource: 50,
    hostSupport: supported,
    ...over,
  }
}

describe("itemAttention", () => {
  it("answers nothing for a healthy item", () => {
    expect(itemAttention(item("app", "a"), { task: task("a"), hostSupport: supported })).toBeNull()
    expect(itemAttention(item("workflow", "w"), { hostSupport: supported })).toBeNull()
  })

  it("puts auto-paused above everything", () => {
    const signal = itemAttention(item("app", "a"), {
      task: task("a", {
        status: "paused",
        lastTerminalReason: "auto-paused",
        consecutiveFailures: 3,
        lastError: "boom",
      }),
      latestRun: run("app:a", "running", 5),
      hostSupport: supported,
    })
    expect(signal).toMatchObject({
      kind: "auto-paused",
      severity: "critical",
      count: 3,
      detail: "boom",
    })
  })

  it("counts consecutive failures from the threshold", () => {
    expect(
      itemAttention(item("app", "a"), {
        task: task("a", { consecutiveFailures: 1 }),
        hostSupport: supported,
      })
    ).toBeNull()
    expect(
      itemAttention(item("app", "a"), {
        task: task("a", { consecutiveFailures: 2 }),
        hostSupport: supported,
      })
    ).toMatchObject({ kind: "consecutive-failures", count: 2 })
  })

  it("reports a running run with its live process count", () => {
    const signal = itemAttention(item("app", "a"), {
      task: task("a"),
      latestRun: run("app:a", "running", 9),
      liveProcesses: 2,
      hostSupport: supported,
    })
    expect(signal).toMatchObject({ kind: "running", severity: "info", processCount: 2 })
    expect(signal?.runUnifiedId).toBe("app:a:run:9")
  })

  it("reports a failed latest run for a kind with no task row", () => {
    const signal = itemAttention(item("workflow", "w"), {
      latestRun: run("workflow:w", "failed", 3),
      hostSupport: supported,
    })
    expect(signal).toMatchObject({ kind: "last-run-failed", severity: "critical" })
  })

  it("reports a task whose last terminal outcome left an error", () => {
    const signal = itemAttention(item("app", "a"), {
      task: task("a", { lastTerminalReason: "execution-timeout", lastError: "took too long" }),
      hostSupport: supported,
    })
    expect(signal).toMatchObject({ kind: "last-run-failed", detail: "took too long" })
  })

  describe("a run that stopped for approval", () => {
    const blocked = (): UnifiedExecutionRun => ({
      ...run("app:a", "failed", 7),
      terminalReason: "needs-approval",
      error: { message: "needs approval: Bash; workspace not trusted (/repo)" },
      result: {
        status: "needs_approval",
        needsApproval: [{ toolName: "Bash" }, { toolName: "Edit" }],
        workspaceTrust: { restricted: true, untrustedRoots: ["/repo"] },
      },
    })

    it("names what it is waiting on, as waiting rather than broken", () => {
      const signal = itemAttention(item("app", "a"), {
        task: task("a", {
          lastTerminalReason: "needs-approval",
          lastError: "needs approval: Bash",
        }),
        latestRun: blocked(),
        hostSupport: supported,
      })
      expect(signal).toEqual({
        id: "needs-approval:app:a",
        kind: "needs-approval",
        severity: "attention",
        itemUnifiedId: "app:a",
        itemName: "a",
        runUnifiedId: "app:a:run:7",
        tools: "Bash, Edit",
        roots: "/repo",
        detail: "needs approval: Bash",
      })
    })

    it("outranks the failure count it also adds to, but not an auto-pause", () => {
      expect(
        itemAttention(item("app", "a"), {
          task: task("a", { consecutiveFailures: 4 }),
          latestRun: blocked(),
          hostSupport: supported,
        })
      ).toMatchObject({ kind: "needs-approval" })
      expect(
        itemAttention(item("app", "a"), {
          task: task("a", {
            status: "paused",
            lastTerminalReason: "auto-paused",
            consecutiveFailures: 4,
          }),
          latestRun: blocked(),
          hostSupport: supported,
        })
      ).toMatchObject({ kind: "auto-paused" })
    })

    it("gives way to a run that has started since", () => {
      expect(
        itemAttention(item("app", "a"), {
          task: task("a", { lastTerminalReason: "needs-approval", lastError: "needs approval" }),
          latestRun: run("app:a", "running", 9),
          hostSupport: supported,
        })
      ).toMatchObject({ kind: "running" })
    })

    it("falls back to the task row when no run is loaded", () => {
      const signal = itemAttention(item("app", "a"), {
        task: task("a", {
          lastTerminalReason: "needs-approval",
          lastError: "needs approval: Bash",
        }),
        hostSupport: supported,
      })
      expect(signal).toMatchObject({ kind: "needs-approval", detail: "needs approval: Bash" })
      expect(signal).not.toHaveProperty("tools")
      expect(signal).not.toHaveProperty("runUnifiedId")
    })
  })

  it("reports a type the host cannot run", () => {
    const signal = itemAttention(item("app", "a"), {
      task: task("a", { type: "background-command" }),
      hostSupport: desktopOnly,
    })
    expect(signal).toMatchObject({
      kind: "unsupported-type",
      severity: "attention",
      reason: "desktop-only",
    })
  })
})

describe("deriveAttention", () => {
  it("orders critical before attention before info, items before globals", () => {
    const items = [item("app", "b"), item("app", "a"), item("workflow", "w")]
    const tasksById = new Map([
      ["a", task("a", { consecutiveFailures: 4 })],
      ["b", task("b")],
    ])
    const signals = deriveAttention(
      input({
        items,
        tasksById,
        runs: [run("app:b", "running", 1), run("app:b", "succeeded", 0)],
        pendingConfirmations: 1,
        hostSuspended: true,
        sourceErrors: { backup: new Error("db locked") },
      })
    )
    expect(signals.map((s) => s.id)).toEqual([
      "consecutive-failures:app:a",
      "source-failed:backup",
      "awaiting-confirmation",
      "host-suspended",
      "running:app:b",
    ])
    expect(signals[1].detail).toBe("db locked")
  })

  it("uses the newest run per item regardless of input order", () => {
    const signals = deriveAttention(
      input({
        items: [item("workflow", "w")],
        runs: [run("workflow:w", "failed", 1), run("workflow:w", "succeeded", 2)],
      })
    )
    expect(signals).toEqual([])
  })

  it("warns when an agent owns 80% of its quota", () => {
    const items = Array.from({ length: 8 }, (_, i) =>
      item("app", `a${i}`, { createdBySource: "agent" })
    )
    items.push(item("app", "u", { createdBySource: "user" }))
    const signals = deriveAttention(input({ items, maxTasksPerSource: 10 }))
    expect(signals).toEqual([
      expect.objectContaining({
        kind: "quota-near-limit",
        writeSource: "agent",
        count: 8,
        limit: 10,
      }),
    ])
    expect(deriveAttention(input({ items: items.slice(0, 7), maxTasksPerSource: 10 }))).toEqual([])
  })

  it("ignores a source error entry that is undefined", () => {
    expect(deriveAttention(input({ sourceErrors: { plugin: undefined } }))).toEqual([])
  })
})

describe("helpers", () => {
  it("ranks null after every severity", () => {
    expect(attentionRank(null)).toBeGreaterThan(
      attentionRank({ id: "x", kind: "running", severity: "info" })
    )
    expect(attentionRank({ id: "x", kind: "auto-paused", severity: "critical" })).toBe(0)
  })

  it("filters signals for one item", () => {
    const signals = deriveAttention(
      input({
        items: [item("app", "a"), item("app", "b")],
        tasksById: new Map([
          ["a", task("a", { consecutiveFailures: 2 })],
          ["b", task("b", { consecutiveFailures: 2 })],
        ]),
      })
    )
    expect(signalsForItem(signals, "app:a").map((s) => s.itemUnifiedId)).toEqual(["app:a"])
  })
})
