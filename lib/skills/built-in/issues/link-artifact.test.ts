/**
 * @jest-environment jsdom
 */

/**
 * `issue.link_artifact`: only the run the calling session is executing in
 * gets the deliverable, and only an artifact of that run's workspace.
 */

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: "w1" }) },
}))
jest.mock("@/lib/db/sessions", () => ({ getSession: async () => undefined }))

import { getSharedBuiltInSkillRegistry } from "../registry"
import type { BuiltInSkillContext } from "../types"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssue } from "@/lib/db/issues"
import { createIssueRun, getIssueRun } from "@/lib/db/issue-runs"
import { getDb } from "@/lib/db/schema"
import { registerIssueRunAdapter, resetIssueRunRegistry } from "@/lib/issues/run/registry"
import "./link-artifact"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)
afterEach(resetIssueRunRegistry)

const HUMAN = { kind: "human" } as const
const skill = getSharedBuiltInSkillRegistry().get("issue.link_artifact")!
const run = (args: Record<string, unknown>, sessionId = "session-of-run") =>
  skill.execute(args as never, { sessionId } as BuiltInSkillContext) as Promise<
    Record<string, unknown>
  >

let runId: string

beforeEach(async () => {
  registerIssueRunAdapter({
    id: "fake",
    kind: "agent-task",
    canRun: async () => ({ ok: true }),
    start: async () => {
      throw new Error("unused")
    },
    poll: async () => null,
    sessionIds: async () => ["session-of-run"],
  })
  const container = await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })
  const issue = await createIssue({
    projectId: "w1",
    issueProjectId: container.id,
    title: "x",
    createdBy: HUMAN,
  })
  runId = (
    await createIssueRun({
      issueId: issue.id,
      projectId: "w1",
      adapterId: "fake",
      kind: "agent-task",
      targetId: "t",
      by: HUMAN,
    })
  ).id
  const artifact = {
    sessionId: "session-of-run",
    messageId: "m",
    type: "code" as const,
    content: "a,b",
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  }
  await getDb().artifacts.bulkPut([
    { ...artifact, id: "a1", projectId: "w1", title: "report.csv" },
    { ...artifact, id: "a2", projectId: "w2", title: "elsewhere" },
  ])
})

describe("issue.link_artifact", () => {
  it("links an artifact to the caller's run as a deliverable titled after it", async () => {
    await expect(run({ artifactId: "a1" })).resolves.toMatchObject({
      status: "linked",
      runId,
      label: "report.csv",
    })
    expect((await getIssueRun(runId))!.artifacts).toEqual([
      {
        label: "report.csv",
        href: "artifact:a1",
        artifactId: "a1",
        sessionId: "session-of-run",
        deliverable: true,
        linkedAt: expect.any(Number),
      },
    ])
  })

  it("links an https URL, labelled after its last path segment unless named", async () => {
    await run({ url: "https://example.com/files/summary.pdf" })
    await run({ url: "https://example.com/x", label: "Deck" })
    expect((await getIssueRun(runId))!.artifacts.map((a) => [a.label, a.href])).toEqual([
      ["summary.pdf", "https://example.com/files/summary.pdf"],
      ["Deck", "https://example.com/x"],
    ])
    await expect(run({ url: "http://example.com/x" })).resolves.toMatchObject({
      reason: "not-https",
    })
  })

  it("refuses outside a run, a missing artifact and another workspace's artifact", async () => {
    await expect(run({ artifactId: "a1" }, "some-chat")).resolves.toMatchObject({
      reason: "not-in-run",
    })
    await expect(run({ artifactId: "nope" })).resolves.toMatchObject({
      reason: "artifact-missing",
    })
    await expect(run({ artifactId: "a2" })).resolves.toMatchObject({
      reason: "artifact-other-workspace",
    })
    expect((await getIssueRun(runId))!.artifacts).toEqual([])
  })

  it("takes exactly one of artifactId and url", () => {
    expect(skill.inputSchema.safeParse({}).success).toBe(false)
    expect(
      skill.inputSchema.safeParse({ artifactId: "a1", url: "https://example.com" }).success
    ).toBe(false)
  })
})
