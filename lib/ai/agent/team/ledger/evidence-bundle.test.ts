import type { ResourceChange } from "@/lib/task-workspace/types"
import { workspaceEvidenceRevision } from "./evidence-bundle"

const resource = (overrides: Partial<ResourceChange> = {}): ResourceChange => ({
  runId: "workspace-run",
  path: "src/main.ts",
  oldPath: null,
  kind: "modified",
  origin: "agent",
  agentId: "mate",
  mediaType: "text/typescript",
  size: 12,
  hash: "current-content",
  beforeHash: "previous-content",
  insertions: 1,
  deletions: 1,
  binary: false,
  resourceKind: "file",
  beforeMode: 420,
  afterMode: 420,
  sensitive: false,
  revision: 3,
  captureClass: "source",
  contentCaptured: true,
  ...overrides,
})

describe("workspace evidence revision", () => {
  it("is stable across resource ordering and does not mutate the snapshot", async () => {
    const a = resource()
    const b = resource({ path: "src/other.ts" })
    const before = structuredClone([a, b])
    const revision = await workspaceEvidenceRevision([a, b])
    expect(revision).toMatch(/^workspace:sha256:[0-9a-f]{64}$/)
    expect(await workspaceEvidenceRevision([b, a])).toBe(revision)
    expect([a, b]).toEqual(before)
  })

  it.each([
    { hash: "changed" },
    { beforeHash: "changed" },
    { revision: 4 },
    { path: "src/new.ts" },
    { oldPath: "src/old.ts" },
    { runId: "other-run" },
    { afterMode: 493 },
    { beforeMode: 493 },
    { resourceKind: "symlink" as const },
    { kind: "renamed" as const },
  ])("changes when material snapshot identity changes: %o", async (change) => {
    expect(await workspaceEvidenceRevision([resource(change)])).not.toBe(
      await workspaceEvidenceRevision([resource()])
    )
  })

  it("rejects incomplete snapshots but binds deletions without current bytes", async () => {
    expect(await workspaceEvidenceRevision([])).toBeUndefined()
    for (const kind of ["created", "modified", "renamed"] as const) {
      expect(
        await workspaceEvidenceRevision([resource(), resource({ kind, hash: null })])
      ).toBeUndefined()
    }
    expect(await workspaceEvidenceRevision([resource({ hash: " " })])).toBeUndefined()
    expect(await workspaceEvidenceRevision([resource({ kind: "deleted", hash: null })])).toMatch(
      /^workspace:sha256:/
    )
  })

  it("binds source changes when Registry also returns metadata-only generated output", async () => {
    const source = resource()
    const generated = resource({
      path: "dist/main.js",
      captureClass: "generated",
      contentCaptured: false,
      hash: null,
      beforeHash: null,
    })
    expect(await workspaceEvidenceRevision([source, generated])).toBe(
      await workspaceEvidenceRevision([source])
    )
    expect(await workspaceEvidenceRevision([generated])).toBeUndefined()
    const legacy = resource({ captureClass: undefined })
    expect(await workspaceEvidenceRevision([legacy])).toBe(
      await workspaceEvidenceRevision([source])
    )
    expect(
      await workspaceEvidenceRevision([
        resource({ captureClass: undefined, hash: null }),
        generated,
      ])
    ).toBeUndefined()
  })
})
