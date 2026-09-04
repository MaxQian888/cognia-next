/**
 * @jest-environment jsdom
 */

/**
 * `issue.create_project`: the container an assistant can now open for itself,
 * and the key collision it has to be able to recover from.
 */

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: "w1" }) },
}))
jest.mock("@/lib/db/sessions", () => ({ getSession: async () => undefined }))

import { getSharedBuiltInSkillRegistry } from "../registry"
import type { BuiltInSkillContext } from "../types"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueProject } from "@/lib/db/issue-projects"
import "./create-project"
import { listIssueProjects } from "@/lib/db/issue-projects"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const CTX = { sessionId: "s1" } as BuiltInSkillContext
const skill = getSharedBuiltInSkillRegistry().get("issue.create_project")!
const run = (args: Record<string, unknown>) =>
  skill.execute(args as never, CTX) as Promise<Record<string, unknown>>

beforeEach(async () => {
  // One container already exists, so the key-collision path has something to
  // collide with and the count assertions have a baseline.
  await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })
})

describe("issue.create_project", () => {
  it("opens a container in the calling workspace", async () => {
    const out = await run({ name: "Comet Migration", key: "COM" })

    expect(out).toMatchObject({ status: "created", key: "COM", workspaceId: "w1" })
    expect(await listIssueProjects({ projectId: "w1" })).toHaveLength(2)
  })

  it("derives a key from the name when none is given", async () => {
    const out = await run({ name: "Delivery Platform" })
    expect(out.status).toBe("created")
    expect(typeof out.key).toBe("string")
    expect(out.key).not.toBe("")
  })

  it("uppercases a lowercase key, because identifiers are printed uppercase", async () => {
    expect(await run({ name: "Comet", key: "com" })).toMatchObject({ key: "COM" })
  })

  it("reports a key collision as an answer rather than throwing", async () => {
    // Keys are globally unique. The model resolves this by picking another
    // one, which it cannot do if the call blows up.
    const out = await run({ name: "Clash", key: "MERC" })
    expect(out.status).toBe("refused")
    expect(typeof out.reason).toBe("string")
  })

  it("records the assistant as the lead", async () => {
    const out = await run({ name: "Comet", key: "COM" })
    const created = (await listIssueProjects({ projectId: "w1" })).find((p) => p.id === out.id)
    expect(created?.lead?.kind).toBe("agent")
  })

  it("carries the optional descriptive fields through", async () => {
    const out = await run({
      name: "Comet",
      key: "COM",
      description: "Second half of the migration",
      status: "planned",
      priority: "high",
      targetDate: 1893456000000,
    })
    const created = (await listIssueProjects({ projectId: "w1" })).find((p) => p.id === out.id)
    expect(created).toMatchObject({
      description: "Second half of the migration",
      status: "planned",
      priority: "high",
      targetDate: 1893456000000,
    })
  })
})
