import {
  WORKSPACE_GROUP_ROW_LIMIT,
  buildWorkspaceSnapshot,
  type WorkspaceIssueInput,
  type WorkspacePlanInput,
  type WorkspaceRunInput,
  type WorkspaceSnapshotStrings,
} from "./workspace-snapshot"

const strings: WorkspaceSnapshotStrings = {
  issuesTitle: "Issues",
  plansTitle: "Plans",
  runsTitle: "Agent runs",
  issuesEmpty: "No open issues",
  plansEmpty: "No active plans",
  runsEmpty: "No agent runs",
  statusText: "Cognia: {count} open",
  statusTooltip: "Open the Cognia panel",
  disconnected: "Cognia: not connected",
  noCustomActions: "none",
  chooseAction: "choose",
  noDiagnostics: "no problems",
}

const issue = (over: Partial<WorkspaceIssueInput> = {}): WorkspaceIssueInput => ({
  id: over.id ?? "i1",
  identifier: over.identifier ?? "MERC-1",
  title: over.title ?? "Ship the board",
  statusCategory: over.statusCategory ?? "unstarted",
  status: over.status ?? "todo",
  updatedAt: over.updatedAt ?? 1,
  ...over,
})

const plan = (over: Partial<WorkspacePlanInput> = {}): WorkspacePlanInput => ({
  id: over.id ?? "p1",
  title: over.title ?? "Refactor auth",
  status: over.status ?? "executing",
  completedSteps: over.completedSteps ?? 1,
  totalSteps: over.totalSteps ?? 4,
  updatedAt: over.updatedAt ?? 1,
})

const run = (over: Partial<WorkspaceRunInput> = {}): WorkspaceRunInput => ({
  id: over.id ?? "r1",
  label: over.label ?? "agent-task",
  status: over.status ?? "running",
  startedAt: over.startedAt ?? 1,
})

const build = (over: Partial<Parameters<typeof buildWorkspaceSnapshot>[0]> = {}) =>
  buildWorkspaceSnapshot({ issues: [], plans: [], runs: [], strings, ...over })

const group = (snapshot: ReturnType<typeof build>, id: string) =>
  snapshot.groups.find((g) => g.id === id)!

describe("shape", () => {
  it("always emits the three groups the extension contributes views for", () => {
    expect(build().groups.map((g) => g.id)).toEqual(["issues", "plans", "runs"])
  })

  it("carries localized titles and empty text through untouched", () => {
    const snapshot = build()
    expect(group(snapshot, "issues").title).toBe("Issues")
    expect(group(snapshot, "runs").emptyText).toBe("No agent runs")
  })
})

describe("issues", () => {
  it("hides finished work — the board is where history lives", () => {
    const snapshot = build({
      issues: [
        issue({ id: "open" }),
        issue({ id: "done", statusCategory: "completed" }),
        issue({ id: "gone", statusCategory: "canceled" }),
      ],
    })
    expect(group(snapshot, "issues").rows.map((r) => r.id)).toEqual(["issue:open"])
  })

  it("lifts started issues above everything else", () => {
    const snapshot = build({
      issues: [
        issue({ id: "old", updatedAt: 100 }),
        issue({ id: "doing", statusCategory: "started", updatedAt: 1 }),
      ],
    })
    expect(group(snapshot, "issues").rows.map((r) => r.id)).toEqual(["issue:doing", "issue:old"])
  })

  it("orders the rest most-recently-touched first", () => {
    const snapshot = build({
      issues: [issue({ id: "a", updatedAt: 1 }), issue({ id: "b", updatedAt: 9 })],
    })
    expect(group(snapshot, "issues").rows.map((r) => r.id)).toEqual(["issue:b", "issue:a"])
  })

  it("prefixes the identifier so a row is recognisable out of context", () => {
    const [row] = build({ issues: [issue({ identifier: "MERC-7", title: "Fix login" })] })
      .groups[0]!.rows
    expect(row!.label).toBe("MERC-7 Fix login")
  })

  it("carries a file target when the issue names one", () => {
    const [row] = build({ issues: [issue({ path: "lib/a.ts", line: 42 })] }).groups[0]!.rows
    expect(row).toMatchObject({ path: "lib/a.ts", line: 42 })
  })

  it("omits the file keys entirely when it names none", () => {
    const [row] = build({ issues: [issue()] }).groups[0]!.rows
    expect(row).not.toHaveProperty("path")
    expect(row).not.toHaveProperty("line")
  })

  it("caps the group so a large backlog cannot flood the panel", () => {
    const many = Array.from({ length: WORKSPACE_GROUP_ROW_LIMIT + 15 }, (_, i) =>
      issue({ id: `i${i}`, updatedAt: i })
    )
    expect(group(build({ issues: many }), "issues").rows).toHaveLength(WORKSPACE_GROUP_ROW_LIMIT)
  })

  it("picks an icon per status category", () => {
    const rows = build({
      issues: [issue({ id: "a" }), issue({ id: "b", statusCategory: "started" })],
    }).groups[0]!.rows
    expect(rows.map((r) => r.icon)).toEqual(["issue-reopened", "issue-opened"])
  })
})

describe("plans", () => {
  it("shows only live plans", () => {
    const snapshot = build({
      plans: [plan({ id: "live" }), plan({ id: "done", status: "completed" })],
    })
    expect(group(snapshot, "plans").rows.map((r) => r.id)).toEqual(["plan:live"])
  })

  it("accepts either spelling of a cancelled plan", () => {
    const snapshot = build({
      plans: [plan({ id: "a", status: "cancelled" }), plan({ id: "b", status: "canceled" })],
    })
    expect(group(snapshot, "plans").rows).toEqual([])
  })

  it("shows progress and status in the description", () => {
    const [row] = build({ plans: [plan({ completedSteps: 2, totalSteps: 5 })] }).groups[1]!.rows
    expect(row!.description).toBe("2/5 · executing")
  })
})

describe("runs", () => {
  it("puts the newest first — that is the one being watched", () => {
    const snapshot = build({
      runs: [run({ id: "old", startedAt: 1 }), run({ id: "new", startedAt: 9 })],
    })
    expect(group(snapshot, "runs").rows.map((r) => r.id)).toEqual(["run:new", "run:old"])
  })

  it("marks a failed run", () => {
    const [row] = build({ runs: [run({ status: "failed" })] }).groups[2]!.rows
    expect(row!.icon).toBe("error")
  })
})

describe("the status bar", () => {
  it("counts the issues it actually shows", () => {
    const snapshot = build({
      issues: [
        issue({ id: "a" }),
        issue({ id: "b" }),
        issue({ id: "c", statusCategory: "completed" }),
      ],
    })
    expect(snapshot.statusText).toBe("Cognia: 2 open")
  })

  it("stays calm for a plain backlog", () => {
    // A permanently orange status bar is a status bar nobody reads.
    expect(build({ issues: [issue(), issue({ id: "b" })] }).attention).toBe(false)
  })

  it("asks for attention on a failed plan", () => {
    expect(build({ plans: [plan({ status: "failed" })] }).attention).toBe(true)
  })

  it("asks for attention on a failed run", () => {
    expect(build({ runs: [run({ status: "failed" })] }).attention).toBe(true)
  })
})
