import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  clearCollabRuns,
  getCollabRun,
  listCollabRuns,
  replaceCollabRuns,
} from "./collab-run-mirror"
import type { CollabRunMirrorRow } from "./collab-run-mirror-types"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().collabRuns.clear()
})
afterAll(dbFixture.dispose)

function row(overrides: Partial<CollabRunMirrorRow> = {}): CollabRunMirrorRow {
  return {
    id: "run_1",
    orgId: "org_acme",
    workspaceId: "proj-1",
    issueId: "iss_1",
    title: "Fix the flake",
    kind: "agent-task",
    status: "running",
    startedBy: { kind: "human", id: "usr_aaaaaaaaaaaaaaaaaaaaaaaa" },
    startedAt: 10,
    updatedAt: 10,
    artifacts: [],
    fetchedAt: 20,
    ...overrides,
  }
}

describe("collab run mirror", () => {
  it("lists the most recently started first", async () => {
    await replaceCollabRuns("org_acme", [
      row({ id: "run_old", startedAt: 1 }),
      row({ id: "run_new", startedAt: 9 }),
    ])
    expect((await listCollabRuns()).map((run) => run.id)).toEqual(["run_new", "run_old"])
  })

  it("answers who is working right now", async () => {
    await replaceCollabRuns("org_acme", [
      row({ id: "run_queued", status: "queued" }),
      row({ id: "run_running", status: "running" }),
      row({ id: "run_done", status: "succeeded" }),
      row({ id: "run_failed", status: "failed" }),
      row({ id: "run_cancelled", status: "cancelled" }),
    ])
    const active = await listCollabRuns({ activeOnly: true })
    expect(active.map((run) => run.id).sort()).toEqual(["run_queued", "run_running"])
  })

  it("keeps an unattached run reachable from its workspace", async () => {
    // Neither an issue nor a plan — the whole reason it carries a title.
    await replaceCollabRuns("org_acme", [
      row({ id: "run_adhoc", issueId: undefined, title: "Ad-hoc sweep" }),
    ])
    const rows = await listCollabRuns({ orgId: "org_acme", workspaceId: "proj-1" })
    expect(rows.map((run) => run.title)).toEqual(["Ad-hoc sweep"])
  })

  it("carries its artifacts inline", async () => {
    await replaceCollabRuns("org_acme", [
      row({ artifacts: [{ label: "PR #12", href: "https://example.com/pr/12" }] }),
    ])
    expect((await getCollabRun("run_1"))?.artifacts).toEqual([
      { label: "PR #12", href: "https://example.com/pr/12" },
    ])
  })

  it("replaces one org's rows without touching another's", async () => {
    await replaceCollabRuns("org_acme", [row({ id: "run_a" })])
    await replaceCollabRuns("org_other", [row({ id: "run_b", orgId: "org_other" })])
    await replaceCollabRuns("org_acme", [row({ id: "run_c" })])

    expect((await listCollabRuns()).map((run) => run.id).sort()).toEqual(["run_b", "run_c"])
    await clearCollabRuns()
    expect(await listCollabRuns()).toEqual([])
  })
})
