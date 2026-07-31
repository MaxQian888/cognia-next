import {
  DEFAULT_EXECUTION_MONITOR_PREFS,
  applyExecutionMonitorPrefs,
  filterExecutionRows,
  groupExecutionRowsByKind,
  isDefaultExecutionMonitorPrefs,
  resolveExecutionMonitorPrefs,
  sortExecutionRows,
  type ExecutionMonitorPrefs,
} from "./monitor-prefs"
import type { UnifiedExecutionRow } from "./monitor-model"

const row = (o: Partial<UnifiedExecutionRow> = {}): UnifiedExecutionRow => ({
  rowId: "broker:leg1",
  source: "broker",
  nativeId: "leg1",
  kind: "connector",
  label: "WeCom reply",
  status: "running",
  startedAt: 1,
  cancellable: true,
  ...o,
})

describe("resolveExecutionMonitorPrefs", () => {
  it("returns the defaults when nothing is stored", () => {
    expect(resolveExecutionMonitorPrefs(undefined)).toEqual(DEFAULT_EXECUTION_MONITOR_PREFS)
  })

  it("drops unknown kinds + de-duplicates the hidden set", () => {
    const prefs = resolveExecutionMonitorPrefs({
      hiddenKinds: ["chat", "chat", "bogus", "team"],
    })
    expect(prefs.hiddenKinds).toEqual(["chat", "team"])
  })

  it("falls back to the default sort for an unknown value", () => {
    expect(resolveExecutionMonitorPrefs({ sort: "sideways" }).sort).toBe("recent")
    expect(resolveExecutionMonitorPrefs({ sort: "kind" }).sort).toBe("kind")
  })

  it("treats groupByKind as opt-in and showElapsed as opt-out", () => {
    expect(resolveExecutionMonitorPrefs({}).groupByKind).toBe(false)
    expect(resolveExecutionMonitorPrefs({ groupByKind: true }).groupByKind).toBe(true)
    expect(resolveExecutionMonitorPrefs({}).showElapsed).toBe(true)
    expect(resolveExecutionMonitorPrefs({ showElapsed: false }).showElapsed).toBe(false)
  })

  it("ignores a non-array hiddenKinds", () => {
    expect(resolveExecutionMonitorPrefs({ hiddenKinds: "chat" as never }).hiddenKinds).toEqual([])
  })
})

describe("isDefaultExecutionMonitorPrefs", () => {
  it("is true only for the factory defaults", () => {
    expect(isDefaultExecutionMonitorPrefs(DEFAULT_EXECUTION_MONITOR_PREFS)).toBe(true)
    expect(
      isDefaultExecutionMonitorPrefs({ ...DEFAULT_EXECUTION_MONITOR_PREFS, hiddenKinds: ["chat"] })
    ).toBe(false)
    expect(
      isDefaultExecutionMonitorPrefs({ ...DEFAULT_EXECUTION_MONITOR_PREFS, sort: "kind" })
    ).toBe(false)
    expect(
      isDefaultExecutionMonitorPrefs({ ...DEFAULT_EXECUTION_MONITOR_PREFS, groupByKind: true })
    ).toBe(false)
    expect(
      isDefaultExecutionMonitorPrefs({ ...DEFAULT_EXECUTION_MONITOR_PREFS, showElapsed: false })
    ).toBe(false)
  })
})

describe("filterExecutionRows", () => {
  it("returns the same reference when nothing is hidden", () => {
    const rows = [row()]
    expect(filterExecutionRows(rows, [])).toBe(rows)
  })

  it("drops rows whose filterable kind is hidden (normalizing scheduler taskType)", () => {
    const rows = [
      row({ rowId: "a", source: "broker", kind: "chat" }),
      row({ rowId: "b", source: "scheduled", kind: "backup" }),
      row({ rowId: "c", source: "workflow", kind: "workflow" }),
    ]
    expect(filterExecutionRows(rows, ["scheduled"]).map((r) => r.rowId)).toEqual(["a", "c"])
    expect(filterExecutionRows(rows, ["chat", "workflow"]).map((r) => r.rowId)).toEqual(["b"])
  })
})

describe("sortExecutionRows", () => {
  const rows = [
    row({ rowId: "1", kind: "team", status: "done", startedAt: 30 }),
    row({ rowId: "2", kind: "chat", status: "running", startedAt: 20 }),
    row({ rowId: "3", kind: "chat", status: "waiting", startedAt: 10 }),
  ]

  it("leaves the incoming order untouched for 'recent'", () => {
    expect(sortExecutionRows(rows, "recent")).toBe(rows)
  })

  it("buckets by kind (declaration order) keeping incoming order within a bucket", () => {
    // chat < team in EXECUTION_FILTER_KINDS; within chat, incoming order 2 then 3.
    expect(sortExecutionRows(rows, "kind").map((r) => r.rowId)).toEqual(["2", "3", "1"])
  })

  it("buckets by status activity (running → waiting → done)", () => {
    expect(sortExecutionRows(rows, "status").map((r) => r.rowId)).toEqual(["2", "3", "1"])
  })
})

describe("groupExecutionRowsByKind", () => {
  it("buckets by filterable kind preserving first-seen order", () => {
    const groups = groupExecutionRowsByKind([
      row({ rowId: "a", source: "broker", kind: "chat" }),
      row({ rowId: "b", source: "scheduled", kind: "backup" }),
      row({ rowId: "c", source: "broker", kind: "chat" }),
    ])
    expect(groups.map((g) => g.kind)).toEqual(["chat", "scheduled"])
    expect(groups[0].rows.map((r) => r.rowId)).toEqual(["a", "c"])
    expect(groups[1].rows.map((r) => r.rowId)).toEqual(["b"])
  })
})

describe("applyExecutionMonitorPrefs", () => {
  it("filters then sorts in one pass", () => {
    const prefs: ExecutionMonitorPrefs = {
      hiddenKinds: ["team"],
      sort: "kind",
      groupByKind: false,
      showElapsed: true,
    }
    const rows = [
      row({ rowId: "1", kind: "team", startedAt: 30 }),
      row({ rowId: "2", kind: "connector", startedAt: 20 }),
      row({ rowId: "3", kind: "chat", startedAt: 10 }),
    ]
    // team hidden; remaining sorted by kind (chat < connector).
    expect(applyExecutionMonitorPrefs(rows, prefs).map((r) => r.rowId)).toEqual(["3", "2"])
  })
})
