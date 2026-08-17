import {
  buildRunActivitySurface,
  formatRunActivityTimeline,
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
