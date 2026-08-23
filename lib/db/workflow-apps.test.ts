jest.mock("@/lib/db/seed", () => ({ seedBuiltIns: jest.fn().mockResolvedValue(undefined) }))

import { createDbTestFixture } from "./test-fixture"
import { getDb } from "./schema"
import {
  createWorkflowApp,
  getWorkflowAppRelease,
  publishWorkflowApp,
  resolvePublishedWorkflowApp,
  resolvePublishedWorkflowAppByDomain,
  rollbackWorkflowApp,
  updateWorkflowAppDraft,
  WorkflowAppConflictError,
} from "./workflow-apps"
import type { WorkflowVersion } from "@/types/workflow/deployment"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().workflowAppReleases.clear()
  await getDb().workflowApps.clear()
  await getDb().workflowDeployments.clear()
  await getDb().workflowVersions.clear()
  await getDb().workflowAnnotationSetRevisions.clear()
  await getDb().workflowAnnotationSets.clear()
  await getDb().workflowReviews.clear()
  await getDb().evalRuns.clear()
  await getDb().evalDatasets.clear()
})
afterAll(dbFixture.dispose)

function version(id: string, workflowId = "wf_1"): WorkflowVersion {
  return {
    id,
    accountId: "account_1",
    workflowId,
    sequence: Number(id.slice(-1)) || 1,
    definition: {
      id: workflowId,
      name: "Published workflow",
      nodes: [],
      edges: [],
      settings: { concurrency: 1 },
      createdAt: 1,
      updatedAt: 1,
    },
    interface: { inputSchema: { type: "object" } },
    dependencyManifest: { nodeTypes: [], workflows: [], credentials: [] },
    configDefinition: { constants: {}, secretRefs: [] },
    digest: `wfv1:${id.padEnd(32, "0")}`,
    name: "Published workflow",
    createdAt: 1,
  }
}

async function seedPublication(versionId = "wfv_1") {
  await getDb().workflowVersions.put(version(versionId))
  await getDb().workflowDeployments.put({
    id: "wfd_1",
    accountId: "account_1",
    workflowId: "wf_1",
    environment: "production",
    versionId,
    revision: 3,
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  })
}

describe("workflow app release control plane", () => {
  it("keeps publication atomic when plugin production preflight fails", async () => {
    const pluginVersion = version("wfv_plugin")
    pluginVersion.definition.nodes = [
      {
        id: "plugin_node",
        type: "action.plugin.invoke",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: {
          label: "Missing plugin",
          params: { pluginId: "missing.production.plugin", mode: "tool", toolName: "lookup" },
        },
      },
    ]
    pluginVersion.dependencyManifest.nodeTypes = [{ kind: "action.plugin.invoke", typeVersion: 1 }]
    await getDb().workflowVersions.put(pluginVersion)
    await getDb().workflowDeployments.put({
      id: "wfd_1",
      accountId: "account_1",
      workflowId: "wf_1",
      environment: "production",
      versionId: pluginVersion.id,
      revision: 1,
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    })
    const app = await createWorkflowApp({
      accountId: "account_1",
      workflowId: "wf_1",
      kind: "workflow",
      slug: "plugin-preflight",
      now: 1_000,
    })

    await expect(
      publishWorkflowApp({
        appId: app.id,
        accountId: "account_1",
        deploymentId: "wfd_1",
      })
    ).rejects.toMatchObject({ code: "plugin-missing" })
    expect(await getDb().workflowAppReleases.where("appId").equals(app.id).count()).toBe(0)
    expect((await getDb().workflowApps.get(app.id))?.currentReleaseId).toBeUndefined()
  })

  it("creates a private app with anonymous, embed, MCP, and sharing disabled", async () => {
    const app = await createWorkflowApp({
      accountId: "account_1",
      workflowId: "wf_1",
      kind: "workflow",
      slug: "release-review",
      now: 1_000,
    })

    expect(app.draftRevision).toBe(1)
    expect(app.currentReleaseId).toBeUndefined()
    expect(app.draft.access).toEqual({ mode: "private", oidcGroupIds: [] })
    expect(app.draft.embed).toEqual({ enabled: false, allowedOrigins: [] })
    expect(app.draft.mcp).toEqual({ enabled: false })
    expect(app.draft.resultSharing).toEqual({ enabled: false })

    await expect(
      createWorkflowApp({
        accountId: "account_1",
        workflowId: "wf_2",
        kind: "workflow",
        slug: "release-review",
        now: 2_000,
      })
    ).rejects.toBeInstanceOf(WorkflowAppConflictError)
  })

  it("uses optimistic revision checks for draft edits", async () => {
    const app = await createWorkflowApp({
      accountId: "account_1",
      workflowId: "wf_1",
      kind: "chatflow",
      slug: "support",
      now: 1_000,
    })
    const updated = await updateWorkflowAppDraft({
      appId: app.id,
      accountId: "account_1",
      expectedRevision: 1,
      patch: {
        blocks: [{ id: "chat", type: "chat", showSources: true }],
        localized: {
          en: { title: "Support" },
          "zh-CN": { title: "支持" },
        },
      },
      now: 2_000,
    })
    expect(updated.draftRevision).toBe(2)
    expect(updated.draft.blocks).toEqual([{ id: "chat", type: "chat", showSources: true }])

    await expect(
      updateWorkflowAppDraft({
        appId: app.id,
        accountId: "account_1",
        expectedRevision: 1,
        patch: { theme: { primaryColor: "#000000", colorMode: "system" } },
        now: 3_000,
      })
    ).rejects.toBeInstanceOf(WorkflowAppConflictError)
  })

  it("publishes only a verified custom domain and resolves its frozen release", async () => {
    await seedPublication()
    const app = await createWorkflowApp({
      accountId: "account_1",
      workflowId: "wf_1",
      kind: "workflow",
      slug: "domain-review",
    })
    const pending = await updateWorkflowAppDraft({
      appId: app.id,
      accountId: "account_1",
      expectedRevision: 1,
      patch: {
        customDomain: {
          hostname: "portal.example.com",
          verificationStatus: "pending",
          verificationToken: "a".repeat(64),
        },
      },
    })
    await expect(
      publishWorkflowApp({
        appId: app.id,
        accountId: "account_1",
        deploymentId: "wfd_1",
      })
    ).rejects.toThrow("Custom domain ownership must be verified before publish")

    await updateWorkflowAppDraft({
      appId: app.id,
      accountId: "account_1",
      expectedRevision: pending.draftRevision,
      patch: {
        customDomain: {
          ...pending.draft.customDomain!,
          verificationStatus: "verified",
          verifiedAt: 10,
        },
      },
    })
    const published = await publishWorkflowApp({
      appId: app.id,
      accountId: "account_1",
      deploymentId: "wfd_1",
    })
    await expect(
      resolvePublishedWorkflowAppByDomain("account_1", "portal.example.com")
    ).resolves.toMatchObject({ release: { id: published.release.id } })
    await expect(
      resolvePublishedWorkflowAppByDomain("account_1", "other.example.com")
    ).resolves.toBeUndefined()
  })

  it("publishes an immutable release and later draft edits cannot change it", async () => {
    await seedPublication()
    const app = await createWorkflowApp({
      accountId: "account_1",
      workflowId: "wf_1",
      kind: "workflow",
      slug: "release-review",
      now: 1_000,
    })
    await updateWorkflowAppDraft({
      appId: app.id,
      accountId: "account_1",
      expectedRevision: 1,
      patch: {
        localized: { en: { title: "Release review" } },
        access: { mode: "anonymous", oidcGroupIds: [] },
      },
      now: 2_000,
    })

    const published = await publishWorkflowApp({
      appId: app.id,
      accountId: "account_1",
      deploymentId: "wfd_1",
      now: 3_000,
      createdBy: "member:alice",
    })
    expect(published.release).toEqual(
      expect.objectContaining({
        sequence: 1,
        versionId: "wfv_1",
        deploymentId: "wfd_1",
        deploymentRevision: 3,
        versionDigest: expect.stringMatching(/^wfv1:/),
        appDraftRevision: 2,
      })
    )

    await updateWorkflowAppDraft({
      appId: app.id,
      accountId: "account_1",
      expectedRevision: 2,
      patch: { localized: { en: { title: "Changed draft" } } },
      now: 4_000,
    })
    expect((await getWorkflowAppRelease(published.release.id))?.snapshot.localized.en.title).toBe(
      "Release review"
    )
    expect((await resolvePublishedWorkflowApp("account_1", "release-review"))?.release.id).toBe(
      published.release.id
    )
  })

  it("freezes exact-version Eval quality evidence into the immutable release", async () => {
    await seedPublication()
    const app = await createWorkflowApp({
      accountId: "account_1",
      workflowId: "wf_1",
      kind: "workflow",
      slug: "quality-gated",
      now: 1_000,
    })
    await updateWorkflowAppDraft({
      appId: app.id,
      accountId: "account_1",
      expectedRevision: 1,
      patch: {
        qualityGate: {
          enabled: true,
          datasetId: "dataset_1",
          thresholds: { minPassAt1: 0.9, maxTotalCostUsd: 1 },
          maxAvgLatencyMs: 2_000,
          maxRunAgeMs: 60_000,
        },
      },
      now: 2_000,
    })
    await getDb().evalDatasets.put({
      id: "dataset_1",
      name: "Release gate",
      capability: "workflow",
      version: 2,
      createdAt: 1,
      updatedAt: 1,
    })
    await expect(
      publishWorkflowApp({
        appId: app.id,
        accountId: "account_1",
        deploymentId: "wfd_1",
        now: 10_000,
      })
    ).rejects.toMatchObject({ code: "quality_gate_failed" })
    await getDb().evalRuns.put({
      runId: "eval_1",
      datasetId: "dataset_1",
      datasetVersion: 2,
      targetLabel: "Pinned release",
      k: 1,
      caseCount: 10,
      gradedCaseCount: 10,
      ungradedCaseCount: 0,
      scorers: {},
      passAt1: 1,
      passHatK: 1,
      totalCostUsd: 0.5,
      avgLatencyMs: 1_000,
      createdAt: 9_000,
      scoringVersion: 2,
      status: "completed",
      config: {
        targetKind: "workflow",
        targetId: "wf_1",
        targetVersionId: "wfv_1",
        scorerIds: [],
        k: 1,
      },
    })

    const published = await publishWorkflowApp({
      appId: app.id,
      accountId: "account_1",
      deploymentId: "wfd_1",
      now: 10_000,
    })
    expect(published.release.qualityGateEvidence).toEqual({
      runId: "eval_1",
      datasetId: "dataset_1",
      datasetVersion: 2,
      evaluatedAt: 10_000,
      failures: [],
    })
  })

  it("freezes the recursively resolved subworkflow deployment lock", async () => {
    const root = version("wfv_1")
    root.dependencyManifest.workflows = [{ workflowId: "wf_child", nodeId: "child_node" }]
    await getDb().workflowVersions.bulkPut([root, version("wfv_child_1", "wf_child")])
    await getDb().workflowDeployments.bulkPut([
      {
        id: "wfd_1",
        accountId: "account_1",
        workflowId: "wf_1",
        environment: "production",
        versionId: "wfv_1",
        revision: 3,
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "wfd_child",
        accountId: "account_1",
        workflowId: "wf_child",
        environment: "production",
        versionId: "wfv_child_1",
        revision: 7,
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    const app = await createWorkflowApp({
      accountId: "account_1",
      workflowId: "wf_1",
      kind: "workflow",
      slug: "with-child",
      now: 1_000,
    })

    const published = await publishWorkflowApp({
      appId: app.id,
      accountId: "account_1",
      deploymentId: "wfd_1",
      now: 2_000,
    })
    expect(published.release.dependencyLock.workflows.child_node).toEqual(
      expect.objectContaining({
        workflowId: "wf_child",
        versionId: "wfv_child_1",
        deploymentId: "wfd_child",
        deploymentRevision: 7,
      })
    )
  })

  it("freezes an app-selected Knowledge Base revision override", async () => {
    await seedPublication()
    await getDb().retrievalGenerations.put({
      id: "gen-pinned",
      corpusId: "knowledge_base:kb-1:source:source-1",
      domain: "kb",
      profileFingerprint: "profile",
      status: "retiring",
      createdAt: 1,
      validation: { count: 1, contentHash: "hash", valid: true },
    })
    const app = await createWorkflowApp({
      accountId: "account_1",
      workflowId: "wf_1",
      kind: "workflow",
      slug: "pinned-knowledge",
      now: 1_000,
    })
    await updateWorkflowAppDraft({
      appId: app.id,
      accountId: "account_1",
      expectedRevision: 1,
      patch: { knowledgeBindings: { "kb-1": "gen-pinned" } },
    })

    const published = await publishWorkflowApp({
      appId: app.id,
      accountId: "account_1",
      deploymentId: "wfd_1",
    })
    expect(published.release.dependencyLock.indexes).toEqual({
      "knowledge:kb-1:app:0": "gen-pinned",
    })
  })

  it("rolls the pointer back without mutating either release", async () => {
    await seedPublication("wfv_1")
    await getDb().workflowVersions.put(version("wfv_2"))
    const app = await createWorkflowApp({
      accountId: "account_1",
      workflowId: "wf_1",
      kind: "workflow",
      slug: "release-review",
      now: 1_000,
    })
    const first = await publishWorkflowApp({
      appId: app.id,
      accountId: "account_1",
      deploymentId: "wfd_1",
      versionId: "wfv_1",
      now: 2_000,
    })
    const second = await publishWorkflowApp({
      appId: app.id,
      accountId: "account_1",
      deploymentId: "wfd_1",
      versionId: "wfv_2",
      now: 3_000,
    })

    const rolledBack = await rollbackWorkflowApp({
      appId: app.id,
      accountId: "account_1",
      releaseId: first.release.id,
      now: 4_000,
    })
    expect(rolledBack.currentReleaseId).toBe(first.release.id)
    expect(rolledBack.publicationRevision).toBe(3)
    expect((await getWorkflowAppRelease(second.release.id))?.versionId).toBe("wfv_2")
  })

  it("rejects versions or deployments outside the app ownership boundary", async () => {
    await seedPublication()
    await getDb().workflowVersions.put({ ...version("foreign", "wf_2"), accountId: "account_2" })
    const app = await createWorkflowApp({
      accountId: "account_1",
      workflowId: "wf_1",
      kind: "workflow",
      slug: "release-review",
      now: 1_000,
    })
    await expect(
      publishWorkflowApp({
        appId: app.id,
        accountId: "account_1",
        deploymentId: "wfd_1",
        versionId: "foreign",
        now: 2_000,
      })
    ).rejects.toThrow(/does not belong/)
  })

  it("freezes the current validated annotation revision into the release", async () => {
    await seedPublication()
    const app = await createWorkflowApp({
      accountId: "account_1",
      workflowId: "wf_1",
      kind: "chatflow",
      slug: "annotated-support",
      now: 1_000,
    })
    await getDb().workflowAnnotationSets.put({
      id: "annotations_1",
      accountId: "account_1",
      appId: app.id,
      name: "Support",
      currentRevisionId: "annotations_revision_1",
      createdAt: 1,
      updatedAt: 1,
      createdBy: "owner",
    })
    await getDb().workflowAnnotationSetRevisions.put({
      id: "annotations_revision_1",
      accountId: "account_1",
      appId: app.id,
      setId: "annotations_1",
      sequence: 1,
      digest: "digest",
      entryCount: 1,
      dimensions: 2,
      embeddingProfileId: "support",
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      vectorBackend: "native",
      validation: { valid: true, errors: [], validatedAt: 1 },
      envelope: {} as never,
      createdAt: 1,
      createdBy: "owner",
    })
    await updateWorkflowAppDraft({
      appId: app.id,
      accountId: "account_1",
      expectedRevision: 1,
      patch: {
        annotationReply: {
          enabled: true,
          setId: "annotations_1",
          threshold: 0.9,
          embeddingProfileId: "support",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          vectorBackend: "native",
        },
      },
    })
    const published = await publishWorkflowApp({
      appId: app.id,
      accountId: "account_1",
      deploymentId: "wfd_1",
    })
    expect(published.release.annotationRevisionId).toBe("annotations_revision_1")

    await getDb().workflowAnnotationSets.update("annotations_1", {
      currentRevisionId: "later_revision",
    })
    expect((await getWorkflowAppRelease(published.release.id))?.annotationRevisionId).toBe(
      "annotations_revision_1"
    )
  })
})
