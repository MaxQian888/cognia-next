import { createDbTestFixture } from "./test-fixture"
import { createWorkflow, updateWorkflow } from "./workflows"
import {
  getWorkflowDeployment,
  getWorkflowDeploymentById,
  listWorkflowVersions,
  resolveWorkflowDeployment,
} from "./workflow-deployments"
import { publishWorkflow, rollbackWorkflow } from "@/lib/workflow/publish/publish-workflow"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("workflow deployments", () => {
  it("resolves the immutable deployed definition rather than the edited draft", async () => {
    const workflow = await createWorkflow({
      name: "Deployed",
      nodes: [],
      edges: [],
    })
    const published = await publishWorkflow(workflow.id, 10)
    await updateWorkflow(workflow.id, { name: "Draft renamed" })

    const resolved = await resolveWorkflowDeployment(workflow.id, "production")

    expect(resolved?.version.id).toBe(published.versionId)
    expect(resolved?.workflow.name).toBe("Deployed")
    expect(resolved?.binding).toMatchObject({
      versionId: published.versionId,
      deploymentId: published.deploymentId,
      deploymentRevision: 1,
    })
  })

  it("rolls the pointer back without deleting newer versions", async () => {
    const workflow = await createWorkflow({ name: "First", nodes: [], edges: [] })
    const first = await publishWorkflow(workflow.id, 10)
    await updateWorkflow(workflow.id, { name: "Second" })
    const second = await publishWorkflow(workflow.id, 20)

    const rollback = await rollbackWorkflow(workflow.id, first.versionId, 30)

    expect(rollback.versionId).toBe(first.versionId)
    expect(rollback.deploymentRevision).toBe(3)
    expect((await getWorkflowDeployment(workflow.id))?.versionId).toBe(first.versionId)
    expect((await resolveWorkflowDeployment(workflow.id))?.workflow.name).toBe("First")
    expect((await listWorkflowVersions(workflow.id)).map((version) => version.id)).toEqual([
      first.versionId,
      second.versionId,
    ])
  })

  it("does not resolve a deployment id owned by another account", async () => {
    const workflow = await createWorkflow({ name: "Scoped", nodes: [], edges: [] })
    const published = await publishWorkflow(workflow.id, 10)

    await expect(getWorkflowDeploymentById(published.deploymentId, "other-account")).resolves.toBe(
      undefined
    )
  })
})
