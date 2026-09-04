/**
 * @jest-environment jsdom
 */

/**
 * The family's shared resolvers and its single write path, against real Dexie.
 *
 * Mocking the data layer here would test nothing that matters: the point of
 * `applyIssueAction` is that the board's capability bits and its run-active
 * guard actually fire, and both read live rows.
 */

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: "w1" }) },
}))
const mockGetSession = jest.fn(async (..._a: unknown[]): Promise<unknown> => undefined)
jest.mock("@/lib/db/sessions", () => ({ getSession: (...a: unknown[]) => mockGetSession(...a) }))
const mockGetCharacter = jest.fn(async (..._a: unknown[]): Promise<unknown> => undefined)
// Spread the real module: the Dexie fixture seeds built-in characters through
// it, and a bare factory would take `seedBuiltInCharacters` away with it.
jest.mock("@/lib/db/characters", () => ({
  ...jest.requireActual("@/lib/db/characters"),
  getCharacter: (...a: unknown[]) => mockGetCharacter(...a),
}))

import type { BuiltInSkillContext } from "../types"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssue, getIssue } from "@/lib/db/issues"
import { createIssueRun } from "@/lib/db/issue-runs"
import {
  applyIssueAction,
  describeOutcome,
  resolveIssue,
  resolveIssueActor,
  resolveIssueProject,
  resolveWorkspaceId,
  summariseIssue,
} from "./_core"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const HUMAN = { kind: "human" } as const
const CTX = { sessionId: "s1" } as BuiltInSkillContext

let containerId: string

beforeEach(async () => {
  mockGetSession.mockResolvedValue(undefined)
  mockGetCharacter.mockResolvedValue(undefined)
  containerId = (await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })).id
})

function makeIssue(over: Record<string, unknown> = {}) {
  return createIssue({
    projectId: "w1",
    issueProjectId: containerId,
    title: "Something",
    createdBy: HUMAN,
    ...over,
  })
}

describe("resolveWorkspaceId", () => {
  it("prefers the calling session's workspace over the window's active one", async () => {
    // An IM or scheduled session has no window, and a session bound to one
    // workspace must not file into whichever the desktop happens to be showing.
    mockGetSession.mockResolvedValue({ id: "s1", projectId: "w_bound" })
    expect(await resolveWorkspaceId(CTX)).toBe("w_bound")
  })

  it("falls back to the active workspace when the session names none", async () => {
    mockGetSession.mockResolvedValue({ id: "s1" })
    expect(await resolveWorkspaceId(CTX)).toBe("w1")
  })

  it("falls back rather than failing when the session lookup throws", async () => {
    // Skills also run in hosts where the session table is not reachable.
    mockGetSession.mockRejectedValue(new Error("no db here"))
    expect(await resolveWorkspaceId(CTX)).toBe("w1")
  })
})

describe("resolveIssueActor", () => {
  it("names the session's character", async () => {
    mockGetSession.mockResolvedValue({ id: "s1", characterId: "c_7" })
    mockGetCharacter.mockResolvedValue({ id: "c_7", name: "Scout" })
    expect(await resolveIssueActor(CTX)).toEqual({ kind: "agent", id: "c_7", label: "Scout" })
  })

  it("stays an agent with no id when no character can be resolved", async () => {
    // Naming the wrong KIND is worse than naming no id: `human` would put a
    // person's name on something a model did.
    expect(await resolveIssueActor(CTX)).toEqual({ kind: "agent" })
  })

  it("keeps the character id when only the character row is missing", async () => {
    mockGetSession.mockResolvedValue({ id: "s1", characterId: "c_gone" })
    mockGetCharacter.mockRejectedValue(new Error("gone"))
    expect(await resolveIssueActor(CTX)).toEqual({ kind: "agent", id: "c_gone" })
  })
})

describe("resolveIssue", () => {
  it("accepts a printed identifier case-insensitively", async () => {
    const issue = await makeIssue()
    expect((await resolveIssue("merc-1", "w1")).id).toBe(issue.id)
  })

  it("accepts a raw id", async () => {
    const issue = await makeIssue()
    expect((await resolveIssue(issue.id, "w1")).id).toBe(issue.id)
  })

  it("refuses an issue in another workspace", async () => {
    // Identifiers are unique across every workspace, so a bare MERC-1 can name
    // a row this session has no business touching.
    await makeIssue()
    await expect(resolveIssue("MERC-1", "w_other")).rejects.toThrow(/another workspace/)
  })

  it("says so when nothing matches", async () => {
    await expect(resolveIssue("NOPE-9", "w1")).rejects.toThrow(/No issue matches/)
  })
})

describe("resolveIssueProject", () => {
  it("accepts a key or an id", async () => {
    expect((await resolveIssueProject("merc", "w1")).id).toBe(containerId)
    expect((await resolveIssueProject(containerId, "w1")).id).toBe(containerId)
  })

  it("refuses a container in another workspace", async () => {
    await expect(resolveIssueProject("MERC", "w_other")).rejects.toThrow(/another workspace/)
  })
})

describe("applyIssueAction", () => {
  it("applies an edit through the board's gate", async () => {
    const issue = await makeIssue()
    const outcome = await applyIssueAction(issue, { kind: "priority", to: "urgent" }, HUMAN)

    expect(outcome).toMatchObject({ applied: 1, skipped: 0, failed: 0 })
    expect(await getIssue(issue.id)).toMatchObject({ priority: "urgent" })
  })

  it("refuses a move while a run holds the issue, and writes nothing", async () => {
    // The whole reason writes route through this layer: an agent must not be
    // able to drag an issue out from under the runtime that is executing it.
    const issue = await makeIssue({ status: "in_progress" })
    await createIssueRun({
      issueId: issue.id,
      projectId: "w1",
      adapterId: "agent-task",
      kind: "agent-task",
      targetId: "t1",
      by: HUMAN,
    })

    const outcome = await applyIssueAction(
      await resolveIssue(issue.id, "w1"),
      { kind: "status", to: "done" },
      HUMAN
    )

    expect(outcome).toMatchObject({ applied: 0, skipped: 1, reason: "runtime-owned" })
    expect(await getIssue(issue.id)).toMatchObject({ status: "in_progress" })
  })
})

describe("describeOutcome", () => {
  it("reports applied, failed and refused separately", () => {
    expect(describeOutcome({ applied: 1, skipped: 0, failed: 0 }, "title")).toEqual({
      field: "title",
      status: "applied",
    })
    expect(describeOutcome({ applied: 0, skipped: 0, failed: 1 }, "title")).toEqual({
      field: "title",
      status: "failed",
    })
    expect(
      describeOutcome({ applied: 0, skipped: 1, failed: 0, reason: "runtime-owned" }, "status")
    ).toEqual({ field: "status", status: "refused", reason: "runtime-owned" })
  })
})

describe("summariseIssue", () => {
  it("carries the identifier the other tools accept back", async () => {
    const issue = await makeIssue()
    expect(summariseIssue(issue)).toMatchObject({
      identifier: "MERC-1",
      status: "backlog",
      assignee: null,
      issueProjectId: containerId,
    })
  })
})
