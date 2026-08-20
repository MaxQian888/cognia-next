import {
  buildRunActivitySurface,
  formatRunActivityTimeline,
  formatRunMilestones,
  formatRunStoppedNote,
  runActivitiesForPresentation,
} from "./activity-to-a2ui"
import { resolveActivityI18n } from "./i18n"
import type { RunProjectionSnapshot } from "@/types/execution/run"

const i18n = resolveActivityI18n("en")

function root(s: A2UIish): { component: string; title: string; children: string[] } {
  return s.components.root as { component: string; title: string; children: string[] }
}

interface A2UIish {
  components: Record<string, unknown>
  dataModel: Record<string, unknown>
  rootId: string
  surfaceType?: string
  title: string
  widget?: Record<string, unknown>
}

function runSnapshot(overrides: Partial<RunProjectionSnapshot> = {}): RunProjectionSnapshot {
  return {
    runId: "run-1",
    kind: "agent-turn",
    title: "Agent run",
    status: "running",
    revision: 4,
    startedAt: 1_000,
    updatedAt: 6_000,
    progress: { completed: 0, total: 0, trustworthy: false },
    activeSteps: [],
    recentSteps: [],
    pendingSteps: [],
    pendingStepCount: 0,
    elapsedMs: 5_000,
    artifacts: [],
    allowedActions: ["stop", "open_details"],
    activities: [
      {
        id: "tool:read",
        kind: "tool",
        category: "read",
        status: "running",
        label: "Read",
        target: { kind: "workspace_path", label: "src/index.ts" },
        startedAt: 2_000,
      },
      {
        id: "tool:search",
        kind: "tool",
        category: "search",
        status: "completed",
        label: "WebSearch",
        startedAt: 1_500,
        endedAt: 2_500,
      },
    ],
    activityCount: 4,
    omittedActivityCount: 2,
    error: "raw stack must never render",
    ...overrides,
  }
}

describe("durable run activity presentation", () => {
  it("sanitizes legacy step labels and never forwards legacy summaries", () => {
    const presented = runActivitiesForPresentation(
      runSnapshot({
        activities: undefined,
        activeSteps: [
          {
            id: "unsafe",
            title: "curl https://example.com?token=secret",
            summary: "raw output",
            status: "in_progress",
          },
        ],
      })
    )

    expect(presented).toEqual([expect.objectContaining({ label: "Activity" })])
    expect(JSON.stringify(presented)).not.toContain("raw output")
    expect(JSON.stringify(presented)).not.toContain("https://")
  })

  it("formats one safe localized timeline without raw errors", () => {
    const text = formatRunActivityTimeline(runSnapshot(), i18n)

    expect(text).toContain("**Agent** · Working · 5s")
    expect(text).toContain("… 2 earlier activities hidden")
    expect(text).toContain("Read · `src/index.ts`")
    expect(text).toContain("WebSearch")
    expect(text).toContain("\n│\n")
    expect(text).not.toContain("raw stack")
  })

  it("builds an A2UI Card with the same plain-text mirror", () => {
    const snapshot = runSnapshot()
    const surface = buildRunActivitySurface(snapshot, i18n) as A2UIish
    const timeline = formatRunActivityTimeline(snapshot, i18n)

    expect(root(surface)).toEqual(
      expect.objectContaining({
        component: "Card",
        title: "Agent",
        children: ["timeline"],
      })
    )
    expect((surface.components.timeline as { text: string }).text).toBe(timeline)
    expect(surface.widget?.fallbackText).toBe(timeline)
  })

  it("hashes PII-shaped run ids in the shared A2UI data model", () => {
    const surface = buildRunActivitySurface(runSnapshot({ runId: "13800138000" }), i18n) as A2UIish

    expect(surface.dataModel.runId).toMatch(/^opaque-[0-9a-f]{8}$/)
    expect(JSON.stringify(surface)).not.toContain("13800138000")
  })

  it("falls back to legacy steps when activities are absent", () => {
    const text = formatRunActivityTimeline(
      runSnapshot({
        activities: undefined,
        activityCount: undefined,
        omittedActivityCount: undefined,
        activeSteps: [{ id: "build", title: "Build", status: "in_progress" }],
      }),
      i18n
    )

    expect(text).toContain("Build")
    expect(text).toContain("◉")
  })
})

describe("milestone block", () => {
  // The gap this closes: the shared surface rendered only
  // `runActivitiesForPresentation` and never read activeSteps / pendingSteps /
  // pendingStepCount, so every platform without a native driver showed a
  // rolling window of tool calls and nothing about the shape of the task.
  const planned = runSnapshot({
    recentSteps: [{ id: "s1", title: "Read the spec", status: "completed" }],
    activeSteps: [{ id: "s2", title: "Write the migration", status: "in_progress" }],
    pendingSteps: [{ id: "s3", title: "Run the gates", status: "pending" }],
    pendingStepCount: 1,
    progress: { completed: 1, total: 3, trustworthy: true },
  })

  it("renders each milestone with its own status", () => {
    const block = formatRunMilestones(planned, i18n)
    expect(block).toContain("Read the spec")
    expect(block).toContain("Write the migration")
    expect(block).toContain("Run the gates")
    expect(block).toContain("1/3")
  })

  it("returns undefined when a run has no plan at all", () => {
    expect(formatRunMilestones(runSnapshot(), i18n)).toBeUndefined()
  })

  it("collapses milestones beyond the window", () => {
    const many = runSnapshot({
      pendingSteps: Array.from({ length: 12 }, (_, index) => ({
        id: `s${index}`,
        title: `Step ${index}`,
        status: "pending" as const,
      })),
      pendingStepCount: 12,
    })
    expect(formatRunMilestones(many, i18n)).toContain("more")
  })

  it("counts projection-omitted pending steps in the remainder", () => {
    const omitted = runSnapshot({
      pendingSteps: [{ id: "s1", title: "One", status: "pending" }],
      pendingStepCount: 5,
    })
    expect(formatRunMilestones(omitted, i18n)).toContain("4 more")
  })

  it("appears above the activity timeline in the shared projection", () => {
    // The shape of the task outranks the last few tool calls for someone
    // deciding whether to intervene.
    const text = formatRunActivityTimeline(planned, i18n)
    const planIndex = text.indexOf("Write the migration")
    const firstActivity = text.indexOf("WebSearch")
    expect(planIndex).toBeGreaterThan(-1)
    expect(firstActivity).toBeGreaterThan(-1)
    expect(planIndex).toBeLessThan(firstActivity)
  })

  it("reaches every non-native platform through the shared surface builder", () => {
    const surface = buildRunActivitySurface(planned, i18n)
    expect(surface.widget?.fallbackText).toContain("Run the gates")
  })
})

describe("terminal stopped note", () => {
  it("names what the run never reached", () => {
    const stuck = runSnapshot({
      status: "failed",
      waitingReason: "sandbox unavailable",
      activeSteps: [{ id: "s2", title: "Write the migration", status: "in_progress" }],
      pendingSteps: [{ id: "s3", title: "Run the gates", status: "pending" }],
      pendingStepCount: 1,
    })
    const note = formatRunStoppedNote(stuck, i18n)
    expect(note).toContain("sandbox unavailable")
    expect(note).toContain("2 milestones not reached")
    expect(formatRunActivityTimeline(stuck, i18n)).toContain("sandbox unavailable")
  })

  it("never renders snapshot.error, which can carry a raw message or stack", () => {
    // The IM projection substitutes a fixed string for `error`, but this
    // builder also runs on raw snapshots and nothing structurally guarantees
    // every caller sanitizes first. The useful "where" is the in-progress
    // milestone, whose title goes through the same sanitizer as every label.
    const raw = runSnapshot({ status: "failed", error: "raw stack must never render" })
    expect(formatRunStoppedNote(raw, i18n)).toBeUndefined()
    expect(formatRunActivityTimeline(raw, i18n)).not.toContain("raw stack")
  })

  it("stays silent while a run is still going", () => {
    const running = runSnapshot({ status: "running", error: "transient" })
    expect(formatRunActivityTimeline(running, i18n)).not.toContain("Stopped:")
  })

  it("returns undefined when there is nothing to explain", () => {
    expect(formatRunStoppedNote(runSnapshot({ status: "completed" }), i18n)).toBeUndefined()
  })
})
