/**
 * @jest-environment jsdom
 */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssue, getIssue } from "@/lib/db/issues"
import { appendIssueEvent, listIssueEvents } from "@/lib/db/issue-events"
import { syncActorFor, type IssueActor } from "@/types/issues"
import { listOpenSyncConflicts, listWorkspaceSyncConflicts, resolveSyncConflict } from "./conflicts"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const HUMAN: IssueActor = { kind: "human" }

async function issueWithConflict(title = "Local") {
  const container = await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })
  const issue = await createIssue({
    projectId: "w1",
    issueProjectId: container.id,
    title,
    createdBy: HUMAN,
  })
  const event = await appendIssueEvent({
    issueId: issue.id,
    payload: {
      kind: "sync_conflict",
      provider: "github",
      field: "title",
      winner: "local",
      localValue: title,
      remoteValue: "Remote",
      by: syncActorFor("github"),
    },
  })
  return { issue, event }
}

describe("listOpenSyncConflicts", () => {
  it("lists a conflict until a resolution names it", async () => {
    const { issue, event } = await issueWithConflict()
    expect(await listOpenSyncConflicts(issue.id)).toEqual([
      {
        eventId: event.id,
        issueId: issue.id,
        ts: event.ts,
        provider: "github",
        field: "title",
        winner: "local",
        localValue: "Local",
        remoteValue: "Remote",
      },
    ])
    expect(await listWorkspaceSyncConflicts("w1")).toHaveLength(1)
    expect(await listWorkspaceSyncConflicts("w9")).toHaveLength(0)

    await appendIssueEvent({
      issueId: issue.id,
      payload: {
        kind: "sync_conflict_resolved",
        conflictEventId: event.id,
        kept: "local",
        by: HUMAN,
      },
    })
    expect(await listOpenSyncConflicts(issue.id)).toEqual([])
    expect(await listWorkspaceSyncConflicts("w1")).toEqual([])
  })
})

describe("resolveSyncConflict", () => {
  it("keeping the winner only closes the conflict", async () => {
    const { issue } = await issueWithConflict()
    const [conflict] = await listOpenSyncConflicts(issue.id)
    await resolveSyncConflict(conflict, "local", HUMAN)
    expect((await getIssue(issue.id))!.title).toBe("Local")
    expect(await listOpenSyncConflicts(issue.id)).toEqual([])
    const kinds = (await listIssueEvents({ issueId: issue.id })).map((e) => e.kind)
    expect(kinds.filter((k) => k === "title_changed")).toHaveLength(0)
  })

  it("keeping the loser writes its value as the person's own edit, so the next sync pushes it", async () => {
    const { issue } = await issueWithConflict()
    const [conflict] = await listOpenSyncConflicts(issue.id)
    await resolveSyncConflict(conflict, "remote", HUMAN)
    expect((await getIssue(issue.id))!.title).toBe("Remote")
    const events = await listIssueEvents({ issueId: issue.id })
    const rename = events.find((e) => e.kind === "title_changed")!
    expect(rename.payload).toMatchObject({ to: "Remote", by: HUMAN })
    expect(events.some((e) => e.kind === "synced_in")).toBe(false)
    expect(await listOpenSyncConflicts(issue.id)).toEqual([])
  })
})
