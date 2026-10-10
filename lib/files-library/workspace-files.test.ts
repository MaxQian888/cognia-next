import type { CodeAdoptionTurnRow } from "@/lib/code-adoption/types"
import type { TaskResourceIndexEntry } from "@/lib/task-workspace/types"
import { mergeWorkspaceFiles, workspaceFileName, workspaceFileSourceId } from "./workspace-files"

function indexEntry(overrides: Partial<TaskResourceIndexEntry> = {}): TaskResourceIndexEntry {
  return {
    sessionId: "s1",
    taskId: "task-1",
    runId: "run-1",
    workspaceRoot: "/repo",
    executionRoot: "/exec/run-1",
    path: "docs/plan.md",
    kind: "created",
    oldPath: null,
    mediaType: "text/markdown",
    size: 12,
    hash: "h",
    binary: false,
    firstChangedAt: 10,
    changedAt: 20,
    ...overrides,
  }
}

function turn(overrides: Partial<CodeAdoptionTurnRow> = {}): CodeAdoptionTurnRow {
  return {
    id: "t1",
    runId: 1,
    sessionId: "s2",
    workspaceRoot: "/repo",
    agentKind: "in-app",
    model: null,
    ts: 5,
    totalFiles: 1,
    totalAdded: 1,
    totalRemoved: 0,
    truncated: false,
    files: [{ path: "src/a.ts", added: 1, removed: 0, isNew: true, hunks: [] }],
    ...overrides,
  } as CodeAdoptionTurnRow
}

describe("workspace file ids", () => {
  it("are stable, sixteen hex digits, and differ by conversation, root and path", () => {
    const id = workspaceFileSourceId("s1", "/repo", "a.md")
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(workspaceFileSourceId("s1", "/repo", "a.md")).toBe(id)
    expect(workspaceFileSourceId("s2", "/repo", "a.md")).not.toBe(id)
    expect(workspaceFileSourceId("s1", "/other", "a.md")).not.toBe(id)
    expect(workspaceFileSourceId("s1", "/repo", "b.md")).not.toBe(id)
    // A path far longer than an item key may be still makes a short id.
    expect(workspaceFileSourceId("s1", "/repo", "x/".repeat(500))).toHaveLength(16)
  })

  it("name a file by its last segment", () => {
    expect(workspaceFileName("docs/plan.md")).toBe("plan.md")
    expect(workspaceFileName("plan.md")).toBe("plan.md")
  })
})

describe("mergeWorkspaceFiles", () => {
  it("takes the ledger's index as it stands", () => {
    expect(mergeWorkspaceFiles([indexEntry({ kind: "renamed", oldPath: "plan.md" })], [])).toEqual([
      {
        sessionId: "s1",
        workspaceRoot: "/repo",
        executionRoot: "/exec/run-1",
        relPath: "docs/plan.md",
        change: "renamed",
        oldPath: "plan.md",
        identityPath: "plan.md",
        mediaType: "text/markdown",
        byteSize: 12,
        createdAt: 10,
        updatedAt: 20,
      },
    ])
  })

  it("keeps a renamed file known by the path it was first listed under", () => {
    const [renamed, standing, second] = mergeWorkspaceFiles(
      [
        indexEntry({ path: "docs/final.md", kind: "created", oldPath: "draft.md" }),
        // A new file now stands where another was renamed from: it keeps its own path.
        indexEntry({ path: "notes.md", kind: "created", oldPath: null }),
        indexEntry({ path: "b.md", kind: "renamed", oldPath: "notes.md" }),
      ],
      []
    )
    expect(renamed).toMatchObject({ relPath: "docs/final.md", identityPath: "draft.md" })
    expect(standing).not.toHaveProperty("identityPath")
    expect(second).not.toHaveProperty("identityPath")
  })

  it("gives the id of a path two files were renamed from to the older one", () => {
    const files = mergeWorkspaceFiles(
      [
        indexEntry({ path: "new.md", kind: "renamed", oldPath: "a.md", firstChangedAt: 30 }),
        indexEntry({ path: "old.md", kind: "renamed", oldPath: "a.md", firstChangedAt: 10 }),
        // Renamed back to where it began: its own path is its id.
        indexEntry({ path: "c.md", kind: "created", oldPath: "c.md" }),
        // Another conversation's file of the same name is not in the way.
        indexEntry({ sessionId: "s9", path: "a.md", kind: "created" }),
      ],
      []
    )
    expect(files.map((file) => [file.relPath, file.identityPath])).toEqual([
      ["new.md", undefined],
      ["old.md", "a.md"],
      ["c.md", undefined],
      ["a.md", undefined],
    ])
  })

  it("fills only the conversations the ledger holds nothing for from turn rows", () => {
    const files = mergeWorkspaceFiles(
      [indexEntry()],
      [
        // s1 is in the ledger: a turn row cannot bring back what it dropped.
        turn({
          sessionId: "s1",
          files: [{ path: "gone.md", added: 1, removed: 0, isNew: true, hunks: [] }],
        }),
        turn(),
      ]
    )
    expect(files.map((file) => [file.sessionId, file.relPath])).toEqual([
      ["s1", "docs/plan.md"],
      ["s2", "src/a.ts"],
    ])
    expect(files[1]).toMatchObject({
      workspaceRoot: "/repo",
      executionRoot: "/repo",
      change: "created",
      createdAt: 5,
      updatedAt: 5,
    })
  })

  it("folds turn rows newest last, keeping a created file created", () => {
    const files = mergeWorkspaceFiles(null, [
      turn({ ts: 9, files: [{ path: "src/a.ts", added: 2, removed: 1, isNew: false, hunks: [] }] }),
      turn({ ts: 5 }),
    ])
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ change: "created", createdAt: 5, updatedAt: 9 })
  })

  it("leaves out discarded changes and credential-shaped paths", () => {
    const files = mergeWorkspaceFiles(null, [
      turn({ adoptionState: "rejected" }),
      turn({
        sessionId: "s3",
        files: [
          { path: ".env", added: 1, removed: 0, isNew: true, hunks: [] },
          { path: "id_rsa", added: 1, removed: 0, isNew: true, hunks: [] },
          { path: "b.ts", added: 1, removed: 0, isNew: true, hunks: [], adoptionState: "reverted" },
          { path: ".\\win\\c.ts", added: 1, removed: 0, isNew: false, hunks: [] },
        ],
      }),
    ])
    expect(files.map((file) => [file.sessionId, file.relPath, file.change])).toEqual([
      ["s3", "win/c.ts", "modified"],
    ])
  })
})
