import {
  EMPTY_ISLAND_STATE,
  NO_ISLAND_CAPABILITIES,
  type IslandRowProjection,
  type IslandRowStatus,
  type IslandState,
} from "@/lib/island/types"

import { buildFleetSlice } from "./build-fleet"
import { GLANCE_FLEET_MAX_ROWS } from "./snapshot"

const NOW = 1_800_000_000_000

function row(
  id: string,
  status: IslandRowStatus,
  extra: Partial<IslandRowProjection> = {}
): IslandRowProjection {
  return {
    id,
    source: "chat",
    owner: { kind: "chat", sessionId: `s-${id}` },
    status,
    priority: 0,
    title: `title ${id}`,
    summary: "",
    startedAt: 100,
    updatedAt: 200,
    capabilities: { ...NO_ISLAND_CAPABILITIES },
    stale: false,
    ...extra,
  }
}

function island(rows: IslandRowProjection[], generatedAt = 5_000): IslandState {
  return { ...EMPTY_ISLAND_STATE, epoch: 1, revision: 1, generatedAt, rows }
}

const ROW_KEYS = [
  "agent",
  "agentLabel",
  "id",
  "startedAt",
  "state",
  "statusKey",
  "title",
  "updatedAt",
  "waitingSince",
]

describe("buildFleetSlice", () => {
  it("returns zeros stamped with now for a null island", () => {
    expect(buildFleetSlice(null, NOW)).toEqual({
      updatedAt: NOW,
      counts: { working: 0, awaiting: 0, failed: 0 },
      total: 0,
      rows: [],
    })
  })

  it("uses now when the island has not generated yet", () => {
    expect(buildFleetSlice(island([], 0), NOW).updatedAt).toBe(NOW)
  })

  it("uses the island's generatedAt when present", () => {
    expect(buildFleetSlice(island([], 1234), NOW).updatedAt).toBe(1234)
  })

  it.each([
    ["blocked", "awaiting"],
    ["failed", "failed"],
    ["working", "working"],
    ["done", "done"],
    ["idle", "idle"],
    ["stale", "stale"],
  ] as const)("maps island status %s to %s", (status, state) => {
    const slice = buildFleetSlice(island([row("a", status)]), NOW)
    expect(slice.rows[0].state).toBe(state)
  })

  it("lets the stale flag win over the status", () => {
    const slice = buildFleetSlice(island([row("a", "working", { stale: true })]), NOW)
    expect(slice.rows[0].state).toBe("stale")
    expect(slice.counts.working).toBe(0)
  })

  it("counts only working, awaiting and failed", () => {
    const slice = buildFleetSlice(
      island([
        row("1", "blocked"),
        row("2", "blocked"),
        row("3", "failed"),
        row("4", "working"),
        row("5", "working"),
        row("6", "working"),
        row("7", "done"),
        row("8", "idle"),
        row("9", "stale"),
        row("10", "working", { stale: true }),
      ]),
      NOW
    )
    expect(slice.counts).toEqual({ working: 3, awaiting: 2, failed: 1 })
    expect(slice.total).toBe(10)
  })

  it("caps rows keeping island order, while total counts all", () => {
    const rows = Array.from({ length: GLANCE_FLEET_MAX_ROWS + 4 }, (_, i) =>
      row(`r${i}`, "working")
    )
    const slice = buildFleetSlice(island(rows), NOW)
    expect(slice.rows).toHaveLength(GLANCE_FLEET_MAX_ROWS)
    expect(slice.rows.map((r) => r.id)).toEqual(
      rows.slice(0, GLANCE_FLEET_MAX_ROWS).map((r) => r.id)
    )
    expect(slice.total).toBe(rows.length)
    // Counts include rows past the cap.
    expect(slice.counts.working).toBe(rows.length)
  })

  it("carries agent, label, status key and timestamps, defaulting absent fields to null", () => {
    const slice = buildFleetSlice(
      island([
        row("a", "blocked", {
          agent: "claude-code",
          agentLabel: "Custom",
          statusKey: "fleet.island.state.waiting",
          startedAt: 11,
          updatedAt: 22,
          waitingSince: 33,
        }),
        row("b", "idle"),
      ]),
      NOW
    )
    expect(slice.rows[0]).toEqual({
      id: "a",
      title: "title a",
      agent: "claude-code",
      agentLabel: "Custom",
      state: "awaiting",
      statusKey: "fleet.island.state.waiting",
      startedAt: 11,
      updatedAt: 22,
      waitingSince: 33,
    })
    expect(slice.rows[1]).toMatchObject({
      agent: null,
      agentLabel: null,
      statusKey: null,
      waitingSince: null,
    })
  })

  describe("content rule", () => {
    const sensitive = island([
      row("secret", "blocked", {
        summary: "a summary the glance must not copy",
        hostRef: "host-ref",
        capabilities: {
          ...NO_ISLAND_CAPABILITIES,
          permissionDecision: true,
          questionResponse: true,
          reply: true,
        },
        permission: {
          requestId: "perm-1",
          kind: "tool",
          toolName: "Bash",
          requestedAt: 1,
          deadline: { at: 99, fallback: "terminal" },
          allowAlways: true,
        },
        question: {
          requestId: "q-1",
          requestedAt: 2,
          deadline: null,
          questions: [
            {
              question: "Which database should I drop?",
              header: "Danger",
              options: ["prod", "staging"],
              multiSelect: false,
            },
          ],
        },
      }),
    ])

    it("emits exactly the GlanceFleetRow keys", () => {
      const slice = buildFleetSlice(sensitive, NOW)
      expect(Object.keys(slice.rows[0]).sort()).toEqual(ROW_KEYS)
    })

    it("never leaks the question, permission, capabilities or summary anywhere in the slice", () => {
      const serialized = JSON.stringify(buildFleetSlice(sensitive, NOW))
      for (const needle of [
        "Which database",
        "prod",
        "Danger",
        "perm-1",
        "q-1",
        "Bash",
        "permission",
        "question",
        "capabilities",
        "summary",
        "a summary the glance",
        "host-ref",
        "owner",
        "s-secret",
      ]) {
        expect(serialized).not.toContain(needle)
      }
    })
  })
})
