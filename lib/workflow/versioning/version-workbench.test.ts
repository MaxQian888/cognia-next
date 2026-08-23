jest.mock("@/lib/db/seed", () => ({ seedBuiltIns: jest.fn().mockResolvedValue(undefined) }))

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { defaultWorkflowAppDraft } from "@/lib/db/workflow-apps"
import { createWorkflow, getWorkflow, updateWorkflow } from "@/lib/db/workflows"
import { publishWorkflow } from "@/lib/workflow/publish/publish-workflow"
import {
  deleteWorkflowVersion,
  exportWorkflowVersion,
  getWorkflowVersionDetails,
  restoreWorkflowVersionToDraft,
  WorkflowVersionInUseError,
} from "./version-workbench"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("workflow version workbench", () => {
  it("restores an immutable definition to the draft without moving production", async () => {
    const workflow = await createWorkflow({ name: "First", nodes: [], edges: [] })
    const first = await publishWorkflow(workflow.id, 10, {
      versionName: "Stable",
      releaseNotes: "Validated production baseline",
    })
    await updateWorkflow(workflow.id, { name: "Second" })
    const second = await publishWorkflow(workflow.id, 20)

    const restored = await restoreWorkflowVersionToDraft(workflow.id, first.versionId, 30)

    expect(restored.name).toBe("First")
    expect(restored.published?.versionId).toBe(second.versionId)
    expect((await getDb().workflowDeployments.get(first.deploymentId))?.versionId).toBe(
      second.versionId
    )
    expect((await getWorkflow(workflow.id))?.updatedAt).toBe(30)
  })

  it("exports the exact version with immutable metadata and no secret values", async () => {
    const workflow = await createWorkflow({ name: "Exported", nodes: [], edges: [] })
    const published = await publishWorkflow(workflow.id, 10, {
      versionName: "August release",
      releaseNotes: "Adds the reviewed answer path",
      createdBy: "member:alice",
    })

    const bundle = await exportWorkflowVersion(workflow.id, published.versionId, 40)

    expect(bundle).toMatchObject({
      format: "cognia-workflow-version",
      formatVersion: 1,
      exportedAt: 40,
      workflowVersion: {
        id: published.versionId,
        versionName: "August release",
        releaseNotes: "Adds the reviewed answer path",
        createdBy: "member:alice",
      },
    })
    expect(JSON.stringify(bundle)).not.toContain('"secretValue"')
  })

  it("reports references and refuses to delete versions used by app releases", async () => {
    const workflow = await createWorkflow({ name: "Referenced", nodes: [], edges: [] })
    const first = await publishWorkflow(workflow.id, 10)
    await updateWorkflow(workflow.id, { name: "Current" })
    await publishWorkflow(workflow.id, 20)
    await getDb().workflowAppReleases.put({
      id: "release_1",
      appId: "app_1",
      accountId: "local_acct_a",
      workflowId: workflow.id,
      appKind: "workflow",
      sequence: 1,
      appDraftRevision: 1,
      versionId: first.versionId,
      versionDigest: "wfv1:test",
      deploymentId: first.deploymentId,
      deploymentRevision: 1,
      workflowInterface: {},
      dependencyLock: { workflows: {}, indexes: {} },
      snapshot: {
        ...defaultWorkflowAppDraft("workflow"),
        localized: { en: { title: "App" }, "zh-CN": { title: "应用" } },
      },
      createdAt: 10,
    })

    const details = await getWorkflowVersionDetails(workflow.id, first.versionId)
    expect(details.references.appReleases).toBe(1)
    expect(details.deletable).toBe(false)
    await expect(deleteWorkflowVersion(workflow.id, first.versionId)).rejects.toBeInstanceOf(
      WorkflowVersionInUseError
    )
  })

  it("detects nested dependency locks and deletes an unreferenced non-current version", async () => {
    const child = await createWorkflow({ name: "Child", nodes: [], edges: [] })
    const childFirst = await publishWorkflow(child.id, 10)
    await updateWorkflow(child.id, { name: "Child current" })
    await publishWorkflow(child.id, 20)

    const parent = await createWorkflow({ name: "Parent", nodes: [], edges: [] })
    const parentRelease = await publishWorkflow(parent.id, 30)
    await getDb().workflowInvocations.put({
      id: "invocation_1",
      accountId: "local_acct_a",
      entrypoint: "portal",
      caller: "member:alice",
      deploymentId: parentRelease.deploymentId,
      deploymentRevision: 1,
      versionId: parentRelease.versionId,
      status: "completed",
      dependencyLock: {
        workflows: {
          child: {
            workflowId: child.id,
            versionId: childFirst.versionId,
            deploymentId: childFirst.deploymentId,
            deploymentRevision: 1,
          },
        },
        indexes: {},
      },
      createdAt: 30,
      updatedAt: 30,
    })

    await expect(deleteWorkflowVersion(child.id, childFirst.versionId)).rejects.toThrow(
      /dependency lock/
    )
    await getDb().workflowInvocations.delete("invocation_1")
    await expect(deleteWorkflowVersion(child.id, childFirst.versionId)).resolves.toBeUndefined()
    expect(await getDb().workflowVersions.get(childFirst.versionId)).toBeUndefined()
  })
})
