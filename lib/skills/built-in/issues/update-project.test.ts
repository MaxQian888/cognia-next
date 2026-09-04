/**
 * @jest-environment jsdom
 */

/**
 * `issue.update_project`: what a container can be amended to, and the one
 * field that is immutable because it is printed on every identifier.
 */

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: "w1" }) },
}))
jest.mock("@/lib/db/sessions", () => ({ getSession: async () => undefined }))

import { getSharedBuiltInSkillRegistry } from "../registry"
import type { BuiltInSkillContext } from "../types"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueProject } from "@/lib/db/issue-projects"
import "./update-project"
import { getIssueProject } from "@/lib/db/issue-projects"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const CTX = { sessionId: "s1" } as BuiltInSkillContext
const skill = getSharedBuiltInSkillRegistry().get("issue.update_project")!
const run = (args: Record<string, unknown>) =>
  skill.execute(args as never, CTX) as Promise<Record<string, unknown>>

let containerId: string

beforeEach(async () => {
  containerId = (await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })).id
})

describe("issue.update_project", () => {
  it("amends a container named by key", async () => {
    const out = await run({ issueProject: "MERC", name: "Mercury Platform", status: "in_progress" })

    expect(out).toMatchObject({ status: "updated", key: "MERC" })
    expect(await getIssueProject(containerId)).toMatchObject({
      name: "Mercury Platform",
      status: "in_progress",
    })
  })

  it("clears a target date when passed null", async () => {
    await run({ issueProject: "MERC", targetDate: 1893456000000 })
    expect(await getIssueProject(containerId)).toMatchObject({ targetDate: 1893456000000 })

    await run({ issueProject: "MERC", targetDate: null })
    expect((await getIssueProject(containerId))?.targetDate).toBeUndefined()
  })

  it("offers no way to change the key", async () => {
    // It is baked into every identifier the container has already minted, and
    // into whatever commits and chat messages quoted them.
    expect(Object.keys(skill.inputSchema.shape)).not.toContain("key")
  })

  it("is a no-op when no field was supplied", async () => {
    expect(await run({ issueProject: "MERC" })).toMatchObject({ status: "no-op", key: "MERC" })
  })

  it("refuses a container in another workspace", async () => {
    await createIssueProject({ projectId: "w2", name: "Venus", key: "VEN" })
    await expect(run({ issueProject: "VEN", name: "Hijack" })).rejects.toThrow(/another workspace/)
  })
})
