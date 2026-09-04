/**
 * @jest-environment jsdom
 */

/**
 * `issue.run`: the door onto the execution bridge that the family did not
 * previously have, and the refusals it has to relay rather than throw.
 */

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: "w1" }) },
}))
jest.mock("@/lib/db/sessions", () => ({ getSession: async () => undefined }))

import type { IssueRunAdapter, IssueRunVerdict } from "@/lib/issues/run/types"
import { getSharedBuiltInSkillRegistry } from "../registry"
import type { BuiltInSkillContext } from "../types"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssue, getIssue } from "@/lib/db/issues"
import { createIssueRun, listIssueRuns } from "@/lib/db/issue-runs"
import { registerIssueRunAdapter, resetIssueRunRegistry } from "@/lib/issues/run/registry"
import "./run"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const HUMAN = { kind: "human" } as const
const CTX = { sessionId: "s1" } as BuiltInSkillContext
const skill = getSharedBuiltInSkillRegistry().get("issue.run")!
const run = (args: Record<string, unknown>) =>
  skill.execute(args as never, CTX) as Promise<Record<string, unknown>>

let containerId: string

/** A stand-in engine, so this file tests the tool rather than an adapter. */
function fakeAdapter(id: string, verdict: IssueRunVerdict): IssueRunAdapter {
  return {
    id,
    kind: "agent-task",
    canRun: async () => verdict,
    start: async (target, context) =>
      createIssueRun({
        issueId: target.issue.id,
        projectId: target.issue.projectId,
        adapterId: id,
        kind: "agent-task",
        targetId: `t_${id}`,
        by: context.by,
      }),
    poll: async () => ({ status: "running" }),
  }
}

beforeEach(async () => {
  resetIssueRunRegistry()
  containerId = (await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })).id
})

afterEach(resetIssueRunRegistry)

function makeIssue(over: Record<string, unknown> = {}) {
  return createIssue({
    projectId: "w1",
    issueProjectId: containerId,
    title: "Something",
    createdBy: HUMAN,
    ...over,
  })
}

describe("issue.run", () => {
  it("dispatches to the only engine that accepts the issue", async () => {
    registerIssueRunAdapter(fakeAdapter("engine-a", { ok: true }))
    const issue = await makeIssue()

    const out = await run({ issue: "MERC-1" })

    expect(out).toMatchObject({ status: "started", adapterId: "engine-a", identifier: "MERC-1" })
    expect(await listIssueRuns({ issueId: issue.id })).toHaveLength(1)
    // Dispatching hands the column to the runtime.
    expect(await getIssue(issue.id)).toMatchObject({ status: "in_progress" })
  })

  it("skips an engine that refuses and takes one that accepts", async () => {
    registerIssueRunAdapter(fakeAdapter("engine-no", { ok: false, reason: "not-supported" }))
    registerIssueRunAdapter(fakeAdapter("engine-yes", { ok: true }))
    await makeIssue()

    expect(await run({ issue: "MERC-1" })).toMatchObject({ adapterId: "engine-yes" })
  })

  it("honours an explicitly named engine", async () => {
    registerIssueRunAdapter(fakeAdapter("engine-a", { ok: true }))
    registerIssueRunAdapter(fakeAdapter("engine-b", { ok: true }))
    await makeIssue()

    expect(await run({ issue: "MERC-1", adapterId: "engine-b" })).toMatchObject({
      adapterId: "engine-b",
    })
  })

  it("reports a named engine that does not exist, and what does", async () => {
    registerIssueRunAdapter(fakeAdapter("engine-a", { ok: true }))
    await makeIssue()

    expect(await run({ issue: "MERC-1", adapterId: "typo" })).toMatchObject({
      status: "refused",
      reason: "adapter-missing",
      available: ["engine-a"],
    })
  })

  it("relays a named engine's own refusal", async () => {
    registerIssueRunAdapter(fakeAdapter("engine-a", { ok: false, reason: "not-supported" }))
    await makeIssue()

    expect(await run({ issue: "MERC-1", adapterId: "engine-a" })).toMatchObject({
      status: "refused",
      reason: "not-supported",
    })
  })

  it("reports every verdict when nothing will take the issue", async () => {
    // A blanket refusal reads the same as a per-engine one from the outside,
    // so the model gets the list rather than a bare no.
    registerIssueRunAdapter(fakeAdapter("engine-a", { ok: false, reason: "not-supported" }))
    await makeIssue()

    const out = await run({ issue: "MERC-1" })
    expect(out).toMatchObject({ status: "refused", reason: "no-engine-accepts" })
    expect(out.verdicts).toEqual([{ adapterId: "engine-a", reason: "not-supported" }])
  })

  it("refuses when no engine is registered at all", async () => {
    await makeIssue()
    expect(await run({ issue: "MERC-1" })).toMatchObject({ reason: "no-engine-accepts" })
  })

  it("refuses a second run while one is already in flight", async () => {
    registerIssueRunAdapter(fakeAdapter("engine-a", { ok: true }))
    const issue = await makeIssue()
    await run({ issue: issue.id })

    expect(await run({ issue: issue.id })).toMatchObject({ status: "refused" })
    expect(await listIssueRuns({ issueId: issue.id })).toHaveLength(1)
  })

  it("refuses an issue in another workspace", async () => {
    registerIssueRunAdapter(fakeAdapter("engine-a", { ok: true }))
    const other = await createIssueProject({ projectId: "w2", name: "Venus", key: "VEN" })
    await createIssue({
      projectId: "w2",
      issueProjectId: other.id,
      title: "Not mine",
      createdBy: HUMAN,
    })

    await expect(run({ issue: "VEN-1" })).rejects.toThrow(/another workspace/)
  })
})
