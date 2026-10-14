import { resolveActivityI18n } from "@/lib/connectors/activity/i18n"
import { reduceRunEvents } from "@/lib/execution/run-reducer"
import type { RunActivitySnapshot, RunProjectionSnapshot, RunEvent } from "@/types/execution/run"
import { formatLarkRunTimeline, larkActivityCount } from "./lark-timeline"

const snapshot: RunProjectionSnapshot = {
  runId: "run",
  kind: "agent-turn",
  title: "Agent run",
  status: "running",
  revision: 1,
  startedAt: 0,
  updatedAt: 2000,
  elapsedMs: 2000,
  activeSteps: [],
  recentSteps: [],
  pendingSteps: [],
  pendingStepCount: 0,
  progress: { completed: 1, total: 2, trustworthy: true },
  artifacts: [],
  allowedActions: [],
}

function activity(overrides: Partial<RunActivitySnapshot> = {}): RunActivitySnapshot {
  return {
    id: "tool",
    kind: "tool",
    category: "read",
    status: "completed",
    label: "Read",
    startedAt: 100,
    endedAt: 1300,
    ...overrides,
  }
}

it.each(["en", "zh-CN"])("renders one compact, entity-escaped row per step in %s", (locale) => {
  const text = formatLarkRunTimeline(
    {
      ...snapshot,
      activities: [
        activity({
          label: "Read <at>*file_name*</at>",
          target: { kind: "workspace_path", label: "src/app_test.ts" },
        }),
        activity({ id: "next", status: "running", endedAt: undefined }),
      ],
    },
    resolveActivityI18n(locale)
  )
  expect(text.split("\n")).toHaveLength(2)
  expect(text).toContain(`<text_tag color='green'>${locale === "en" ? "Done" : "完成"}</text_tag>`)
  expect(text).toContain(
    `<text_tag color='turquoise'>${locale === "en" ? "Running" : "进行中"}</text_tag>`
  )
  expect(text).toContain("Read &#60;at&#62;&#42;file&#95;name&#42;&#60;/at&#62;")
  expect(text).toContain("<font color='grey'>· 1.2s · src/app&#95;test.ts</font>")
  expect(text).not.toMatch(/[\\`│⌕▤◇◆▣◷◉]/)
  expect(text).not.toContain("\n\n")
})

it("renders narration quietly and collapses only adjacent identical commentary", () => {
  const commentary = activity({
    kind: "step",
    category: "status",
    label: "Reviewing `node` behavior",
  })
  const text = formatLarkRunTimeline(
    {
      ...snapshot,
      activities: [
        commentary,
        { ...commentary, id: "same" },
        activity(),
        { ...commentary, id: "later" },
      ],
    },
    resolveActivityI18n("en")
  )
  expect(text.split("\n")).toEqual([
    "<font color='grey'>Reviewing node behavior</font>",
    "<text_tag color='green'>Done</text_tag> Read <font color='grey'>· 1.2s</font>",
    "<font color='grey'>Reviewing node behavior</font>",
  ])
})

it.each([false, true])(
  "does not duplicate reducer commentary as plan milestones (plan: %s)",
  (withPlan) => {
    const rows: Array<Pick<RunEvent, "type" | "payload">> = [
      ...(withPlan
        ? [
            {
              type: "plan.created" as const,
              payload: {
                steps: [
                  { id: "real-step", title: "Review results", safeTitle: true, status: "pending" },
                ],
              },
            },
          ]
        : []),
      {
        type: "step.started",
        payload: {
          stepId: "commentary:c1",
          category: "status",
          title: "Checking `code` and git history",
          safeTitle: true,
        },
      },
    ]
    const value = reduceRunEvents(
      {
        id: "run",
        kind: "agent-turn",
        sourceId: "turn",
        title: "Agent run",
        status: "running",
        currentRevision: 0,
        startedAt: 0,
        updatedAt: 0,
      },
      rows.map((row, index) => ({
        ...row,
        id: `event-${index}`,
        runId: "run",
        seq: index + 1,
        ts: index + 1,
        visibility: "summary",
      }))
    )
    // The runner may already have reduced the duplicated step title. The
    // structured source identity still identifies it as narration.
    value.activeSteps = value.activeSteps.map((step) => ({ ...step, title: "Step" }))
    const text = formatLarkRunTimeline(value, resolveActivityI18n("en"))
    expect(text.match(/Checking code and git history/g)).toHaveLength(1)
    expect(text).toContain("<font color='grey'>Checking code and git history</font>")
    expect(text).not.toContain("</text_tag> Step")
    expect(text.includes("Review results")).toBe(withPlan)
    expect(text.includes("Plan ·")).toBe(withPlan)
  }
)

it("retains milestones, omitted steps, stopped notes and queue depth with the same native styling", () => {
  const value: RunProjectionSnapshot = {
    ...snapshot,
    status: "failed",
    waitingReason: "review *required*",
    connectorQueueDepth: 2,
    activeSteps: [{ id: "blocked", title: "Check <at>_value_</at>", status: "blocked" }],
    pendingSteps: [{ id: "pending", title: "Publish", status: "pending" }],
    pendingStepCount: 4,
    activities: [activity({ status: "failed" }), activity({ status: "skipped" })],
    activityCount: 8,
    omittedActivityCount: 6,
  }
  const text = formatLarkRunTimeline(value, resolveActivityI18n("en"))
  expect(text).toContain("<font color='grey'>2 queued turns</font>")
  expect(text).toContain("<font color='grey'>Plan · 1/5</font>")
  expect(text).toContain(
    "<text_tag color='orange'>Waiting</text_tag> Check &#60;at&#62;&#95;value&#95;&#60;/at&#62;"
  )
  expect(text).toContain("<text_tag color='neutral'>Waiting</text_tag> Publish")
  expect(text).toContain("<text_tag color='red'>Failed</text_tag>")
  expect(text).toContain("<text_tag color='neutral'>Skipped</text_tag>")
  expect(text).toContain("<font color='grey'>… and 3 more</font>")
  expect(text).toContain("<font color='grey'>Stopped: review &#42;required&#42;</font>")
  expect(text).toContain("<font color='grey'>1 milestone not reached</font>")
  expect(text).toContain("<font color='grey'>… 6 earlier activities hidden</font>")
  expect(larkActivityCount(value)).toBe(8)
})

it("provides a nonempty safe empty state and never invents unfinished durations", () => {
  expect(formatLarkRunTimeline(snapshot, resolveActivityI18n("en"))).toBe(
    "<font color='grey'>No public activity yet</font>"
  )
  const text = formatLarkRunTimeline(
    { ...snapshot, activities: [activity({ endedAt: undefined })] },
    resolveActivityI18n("en")
  )
  expect(text).not.toContain("s</font>")
  expect(larkActivityCount(snapshot)).toBe(0)
})
