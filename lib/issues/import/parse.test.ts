import {
  detectIssueImportFormat,
  parseCsvIssues,
  parseDate,
  parseIssueImport,
  parseJsonIssues,
  parseLabels,
  parseMarkdownIssues,
  parsePriority,
  parseStatus,
  resolveColumns,
  stableRowId,
} from "./parse"

describe("stableRowId", () => {
  it("is deterministic, case and whitespace insensitive, and 8 hex chars", () => {
    expect(stableRowId(["a", "b"])).toBe(stableRowId([" A ", "B"]))
    expect(stableRowId(["a", "b"])).not.toBe(stableRowId(["a", "c"]))
    expect(stableRowId(["x"])).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe("column vocabulary", () => {
  it("resolves aliases case-insensitively and keeps the first hit per field", () => {
    const columns = resolveColumns([
      "Summary",
      "Body",
      "State",
      "Assigned To",
      "Tags",
      "Due Date",
      "Story Points",
      "Epic",
      "Key",
      "Title",
    ])
    expect(columns.get("title")).toBe("Summary")
    expect(columns.get("description")).toBe("Body")
    expect(columns.get("status")).toBe("State")
    expect(columns.get("assigneeLabel")).toBe("Assigned To")
    expect(columns.get("labels")).toBe("Tags")
    expect(columns.get("dueDate")).toBe("Due Date")
    expect(columns.get("estimate")).toBe("Story Points")
    expect(columns.get("parentExternalId")).toBe("Epic")
    expect(columns.get("sourceId")).toBe("Key")
  })

  it("maps status, priority, dates, numbers and labels with aliases", () => {
    expect(parseStatus("In Review")).toBe("in_review")
    expect(parseStatus("closed")).toBe("done")
    expect(parseStatus("won't fix")).toBe("canceled")
    expect(parseStatus("???")).toBeUndefined()
    expect(parsePriority("P0")).toBe("urgent")
    expect(parsePriority("Normal")).toBe("medium")
    expect(parsePriority("")).toBeUndefined()
    expect(parseDate("2026-09-06")).toBe(new Date(2026, 8, 6, 12).getTime())
    expect(parseDate("nonsense")).toBeUndefined()
    expect(parseLabels("bug, ui;ops|x")).toEqual(["bug", "ui", "ops", "x"])
    expect(parseLabels(["a", " b "])).toEqual(["a", "b"])
  })
})

describe("parseCsvIssues", () => {
  it("reads records into rows, skips titleless ones and links parents by key", () => {
    const csv = [
      "Key,Title,Description,Status,Priority,Assignee,Labels,Due,Points,Parent",
      'MERC-1,Epic one,"Big, quoted",todo,high,Ada,"bug, ui",2026-09-06,5,',
      "MERC-2,Child,,in progress,,,,,,MERC-1",
      "MERC-3,,no title,,,,,,,",
      "MERC-4,Orphan,,,,,,,,MERC-99",
    ].join("\n")
    const parsed = parseCsvIssues(csv)
    expect(parsed.format).toBe("csv")
    expect(parsed.skipped).toEqual([{ index: 2, reason: "no-title" }])
    expect(parsed.rows).toHaveLength(3)
    const [epic, child, orphan] = parsed.rows
    expect(epic).toMatchObject({
      title: "Epic one",
      description: "Big, quoted",
      status: "todo",
      priority: "high",
      assigneeLabel: "Ada",
      labels: ["bug", "ui"],
      estimate: 5,
      sourceId: "MERC-1",
    })
    expect(epic.dueDate).toBe(new Date(2026, 8, 6, 12).getTime())
    expect(child.parentExternalId).toBe(epic.externalId)
    expect(child.status).toBe("in_progress")
    expect(orphan.parentExternalId).toBeUndefined()
    // Same file, same ids.
    expect(parseCsvIssues(csv).rows.map((row) => row.externalId)).toEqual(
      parsed.rows.map((row) => row.externalId)
    )
  })
})

describe("parseJsonIssues", () => {
  it("accepts a bare array and the tracker's own export shape", () => {
    const bare = parseJsonIssues(JSON.stringify([{ title: "A", tags: ["x"] }, { nope: 1 }, "junk"]))
    expect(bare.rows).toHaveLength(1)
    expect(bare.rows[0]).toMatchObject({ title: "A", labels: ["x"] })
    expect(bare.skipped).toHaveLength(2)

    const own = parseJsonIssues(
      JSON.stringify({
        issues: [
          {
            id: "iss_1",
            identifier: "MERC-1",
            title: "Parent",
            assignee: { kind: "human", label: "Ada" },
            labelNames: ["bug"],
          },
          { id: "iss_2", identifier: "MERC-2", title: "Child", parentId: "MERC-1", status: "done" },
        ],
      })
    )
    expect(own.rows[0]).toMatchObject({
      title: "Parent",
      assigneeLabel: "Ada",
      labels: ["bug"],
      sourceId: "MERC-1",
    })
    expect(own.rows[1].parentExternalId).toBe(own.rows[0].externalId)
    expect(own.rows[1].status).toBe("done")
  })

  it("refuses text that is not JSON", () => {
    expect(() => parseJsonIssues("{oops")).toThrow(/JSON/)
  })
})

describe("parseMarkdownIssues", () => {
  it("turns headings into parents, nested tasks into children and bullets into descriptions", () => {
    const md = [
      "# Release 1.0",
      "- [ ] Ship login",
      "  - [x] Design form",
      "  - [ ] Wire API",
      "    - uses the v2 endpoint",
      "- [ ] Docs",
      "## Later",
      "- [ ] Dark mode",
    ].join("\n")
    const parsed = parseMarkdownIssues(md)
    const titles = parsed.rows.map((row) => row.title)
    expect(titles).toEqual([
      "Release 1.0",
      "Ship login",
      "Design form",
      "Wire API",
      "Docs",
      "Later",
      "Dark mode",
    ])
    const [release, login, design, wire, docs, later, dark] = parsed.rows
    expect(login.parentExternalId).toBe(release.externalId)
    expect(design.parentExternalId).toBe(login.externalId)
    expect(design.status).toBe("done")
    expect(wire.parentExternalId).toBe(login.externalId)
    expect(wire.description).toBe("uses the v2 endpoint")
    expect(docs.parentExternalId).toBe(release.externalId)
    expect(dark.parentExternalId).toBe(later.externalId)
    expect(parsed.skipped).toEqual([])
  })

  it("works without any heading", () => {
    const parsed = parseMarkdownIssues("- [ ] Only task\n- [ ] Second")
    expect(parsed.rows.map((row) => row.parentExternalId)).toEqual([undefined, undefined])
  })
})

describe("detectIssueImportFormat / parseIssueImport", () => {
  it("prefers the file extension, then sniffs the content", () => {
    expect(detectIssueImportFormat("", "backlog.CSV")).toBe("csv")
    expect(detectIssueImportFormat("", "x.json")).toBe("json")
    expect(detectIssueImportFormat("", "x.md")).toBe("markdown")
    expect(detectIssueImportFormat("[{}]")).toBe("json")
    expect(detectIssueImportFormat("- [ ] a")).toBe("markdown")
    expect(detectIssueImportFormat("title,status\nA,todo")).toBe("csv")
    expect(parseIssueImport("csv", "title\nA").rows[0].title).toBe("A")
  })
})
