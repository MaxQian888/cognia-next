import {
  claimNextSiteOperation,
  createSiteDeployment,
  completeSiteOperation,
  completeSiteVersion,
  createSiteEnvironmentRevision,
  createSiteProject,
  createSiteVersionDraft,
  deleteSiteProjectMetadata,
  getSiteArtifact,
  getSiteOperation,
  listSiteDeployments,
  listSiteOperationEvents,
  listSiteProjects,
  putSiteArtifact,
  queueSiteOperation,
  recordSiteResource,
  markSiteDeploymentActive,
  markSiteOperationForReconcile,
  failSiteOperation,
  setSiteLifecycle,
  siteResourceCanBePurged,
} from "./sites"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

function siteInput() {
  return {
    id: "site_1",
    name: "Docs",
    projectId: "project_1",
    sourceRoot: "/workspace",
    sourceSubpath: "./apps/docs/",
    executionTarget: { kind: "local" },
    provider: "cloudflare",
    providerConfig: { workerName: "cognia-docs", accountId: "account_1" },
    authoringPolicy: {
      ownerAccountId: "owner_1",
      editorAccountIds: [] as string[],
      deployerAccountIds: [] as string[],
    },
    visitorPolicy: { mode: "private" },
    now: 100,
  } as const
}

async function makeSite() {
  return createSiteProject(siteInput())
}

describe("site project identity", () => {
  it("links to an existing project and normalizes the explicit source subpath", async () => {
    const site = await makeSite()

    expect(site).toMatchObject({
      id: "site_1",
      projectId: "project_1",
      sourceRoot: "/workspace",
      sourceSubpath: "apps/docs",
      executionTargetKey: "local",
      lifecycle: "active",
    })
    expect(await listSiteProjects()).toEqual([site])
  })

  it("rejects an absolute or escaping source subpath", async () => {
    await expect(
      createSiteProject({
        ...siteInput(),
        id: "site_absolute",
        sourceSubpath: "/etc",
      })
    ).rejects.toThrow("relative")

    await expect(
      createSiteProject({
        ...siteInput(),
        id: "site_escape",
        sourceSubpath: "../../etc",
      })
    ).rejects.toThrow("escape")
  })

  it("prevents duplicate Site bindings for the same project, root, subpath, and target", async () => {
    await makeSite()
    await expect(makeSite()).rejects.toThrow("already exists")
  })
})

describe("immutable artifacts, environment revisions, and versions", () => {
  it("stores artifact bytes by digest and refuses digest collisions", async () => {
    const first = await putSiteArtifact({
      digest: "a".repeat(64),
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "application/gzip",
      fileCount: 4,
      now: 100,
    })
    const same = await putSiteArtifact({
      digest: "a".repeat(64),
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "application/gzip",
      fileCount: 4,
      now: 200,
    })

    expect(same).toEqual(first)
    expect((await getSiteArtifact(first.digest))?.bytes).toEqual(new Uint8Array([1, 2, 3]))

    await expect(
      putSiteArtifact({
        digest: "a".repeat(64),
        bytes: new Uint8Array([9]),
        mediaType: "application/gzip",
        fileCount: 1,
      })
    ).rejects.toThrow("digest collision")
  })

  it("creates immutable environment revisions containing secret references, never values", async () => {
    await makeSite()
    const revision = await createSiteEnvironmentRevision({
      id: "env_1",
      siteId: "site_1",
      variables: { API_ORIGIN: "https://api.example.com" },
      secretRefs: [{ key: "API_TOKEN", credentialId: "site_1:API_TOKEN", revision: "rev_2" }],
      now: 120,
    })

    expect(revision.sequence).toBe(1)
    expect(revision.secretRefs).toEqual([
      { key: "API_TOKEN", credentialId: "site_1:API_TOKEN", revision: "rev_2" },
    ])
    expect(JSON.stringify(revision)).not.toContain("secretValue")
  })

  it("completes a version only when its immutable artifact and environment revision exist", async () => {
    await makeSite()
    await createSiteEnvironmentRevision({
      id: "env_1",
      siteId: "site_1",
      variables: {},
      secretRefs: [],
      now: 110,
    })
    const draft = await createSiteVersionDraft({
      id: "version_1",
      siteId: "site_1",
      environmentRevisionId: "env_1",
      source: {
        commitSha: "abc123",
        dirty: false,
        lockfileDigest: "b".repeat(64),
        inputDigest: "c".repeat(64),
      },
      build: {
        command: "pnpm build",
        runtime: "node@24.4.1",
        packageManager: "pnpm@10.13.1",
        compatibilityDate: "2026-07-18",
        compatibilityFlags: ["nodejs_compat"],
        routes: [],
        bindings: [],
      },
      now: 120,
    })
    expect(draft.sequence).toBe(1)
    expect(draft.status).toBe("building")

    await expect(
      completeSiteVersion({
        versionId: "version_1",
        artifactDigest: "d".repeat(64),
        now: 130,
      })
    ).rejects.toThrow("artifact")

    await putSiteArtifact({
      digest: "d".repeat(64),
      bytes: new Uint8Array([4, 5]),
      mediaType: "application/gzip",
      fileCount: 2,
      now: 130,
    })
    const ready = await completeSiteVersion({
      versionId: "version_1",
      artifactDigest: "d".repeat(64),
      now: 140,
    })
    expect(ready).toMatchObject({ status: "ready", completedAt: 140 })

    await expect(
      completeSiteVersion({
        versionId: "version_1",
        artifactDigest: "d".repeat(64),
      })
    ).rejects.toThrow("immutable")
  })
})

describe("durable site operations", () => {
  it("deduplicates by idempotency key and claims work with an expiring lease", async () => {
    await makeSite()
    const queued = await queueSiteOperation({
      id: "op_1",
      siteId: "site_1",
      type: "deploy",
      executionTargetKey: "local",
      idempotencyKey: "deploy:site_1:version_1",
      inputDigest: "e".repeat(64),
      now: 100,
    })
    const duplicate = await queueSiteOperation({
      id: "op_other",
      siteId: "site_1",
      type: "deploy",
      executionTargetKey: "local",
      idempotencyKey: "deploy:site_1:version_1",
      inputDigest: "e".repeat(64),
      now: 101,
    })
    expect(duplicate.id).toBe(queued.id)

    const claimed = await claimNextSiteOperation({
      executionTargetKey: "local",
      leaseOwner: "window_1",
      now: 200,
      leaseMs: 1_000,
    })
    expect(claimed).toMatchObject({
      id: "op_1",
      status: "running",
      leaseOwner: "window_1",
      leaseExpiresAt: 1_200,
      attemptCount: 1,
    })
    expect(
      await claimNextSiteOperation({
        executionTargetKey: "local",
        leaseOwner: "window_2",
        now: 300,
        leaseMs: 1_000,
      })
    ).toBeUndefined()

    const reclaimed = await claimNextSiteOperation({
      executionTargetKey: "local",
      leaseOwner: "window_2",
      now: 1_201,
      leaseMs: 500,
    })
    expect(reclaimed).toMatchObject({ leaseOwner: "window_2", attemptCount: 2 })
  })

  it("appends sequenced events and requires the active lease owner to complete", async () => {
    await makeSite()
    await queueSiteOperation({
      id: "op_1",
      siteId: "site_1",
      type: "reconcile",
      executionTargetKey: "local",
      idempotencyKey: "reconcile:1",
      inputDigest: "f".repeat(64),
      now: 100,
    })
    await claimNextSiteOperation({
      executionTargetKey: "local",
      leaseOwner: "window_1",
      now: 110,
      leaseMs: 1_000,
    })

    await expect(
      completeSiteOperation({ operationId: "op_1", leaseOwner: "window_2", now: 120 })
    ).rejects.toThrow("lease")
    await completeSiteOperation({
      operationId: "op_1",
      leaseOwner: "window_1",
      providerRequestId: "cf_request_1",
      now: 130,
    })

    expect(await getSiteOperation("op_1")).toMatchObject({
      status: "succeeded",
      providerRequestId: "cf_request_1",
      completedAt: 130,
    })
    const events = await listSiteOperationEvents("op_1")
    expect(events.map((event) => [event.sequence, event.type])).toEqual([
      [1, "queued"],
      [2, "claimed"],
      [3, "succeeded"],
    ])
  })

  it("records uncertain provider outcomes for reconciliation and terminal failures separately", async () => {
    await makeSite()
    await queueSiteOperation({
      id: "op_1",
      siteId: "site_1",
      type: "provision",
      executionTargetKey: "local",
      idempotencyKey: "provision:1",
      inputDigest: "a".repeat(64),
      now: 100,
    })
    await claimNextSiteOperation({
      executionTargetKey: "local",
      leaseOwner: "window_1",
      now: 110,
      leaseMs: 1_000,
    })
    await markSiteOperationForReconcile({
      operationId: "op_1",
      leaseOwner: "window_1",
      providerRequestId: "cf_uncertain",
      message: "timed out after upload",
      now: 120,
    })
    expect(await getSiteOperation("op_1")).toMatchObject({
      status: "waiting-reconcile",
      providerRequestId: "cf_uncertain",
    })

    await queueSiteOperation({
      id: "op_2",
      siteId: "site_1",
      type: "domain",
      executionTargetKey: "local",
      idempotencyKey: "domain:1",
      inputDigest: "b".repeat(64),
      now: 130,
    })
    await claimNextSiteOperation({
      executionTargetKey: "local",
      leaseOwner: "window_1",
      now: 140,
      leaseMs: 1_000,
    })
    await failSiteOperation({
      operationId: "op_2",
      leaseOwner: "window_1",
      message: "invalid zone",
      now: 150,
    })
    expect(await getSiteOperation("op_2")).toMatchObject({
      status: "failed",
      errorMessage: "invalid zone",
      completedAt: 150,
    })
  })
})

describe("deployments", () => {
  it("deploys only ready versions and supersedes the previous active deployment", async () => {
    await makeSite()
    await createSiteEnvironmentRevision({
      id: "env_1",
      siteId: "site_1",
      variables: {},
      secretRefs: [],
      now: 100,
    })
    await createSiteVersionDraft({
      id: "version_1",
      siteId: "site_1",
      environmentRevisionId: "env_1",
      source: {
        commitSha: "abc",
        dirty: false,
        lockfileDigest: "a".repeat(64),
        inputDigest: "b".repeat(64),
      },
      build: {
        command: "pnpm build",
        runtime: "node@24",
        packageManager: "pnpm@10",
        compatibilityDate: "2026-07-18",
        compatibilityFlags: [],
        routes: [],
        bindings: [],
      },
      now: 110,
    })
    await expect(
      createSiteDeployment({
        id: "deployment_1",
        siteId: "site_1",
        versionId: "version_1",
        environmentRevisionId: "env_1",
        now: 120,
      })
    ).rejects.toThrow("ready")
    await putSiteArtifact({
      digest: "c".repeat(64),
      bytes: new Uint8Array([1]),
      mediaType: "application/gzip",
      fileCount: 1,
      now: 120,
    })
    await completeSiteVersion({
      versionId: "version_1",
      artifactDigest: "c".repeat(64),
      now: 130,
    })
    await createSiteDeployment({
      id: "deployment_1",
      siteId: "site_1",
      versionId: "version_1",
      environmentRevisionId: "env_1",
      now: 140,
    })
    await markSiteDeploymentActive({
      deploymentId: "deployment_1",
      providerDeploymentId: "cf_deployment_1",
      productionUrl: "https://docs.example.workers.dev",
      now: 150,
    })
    expect(await listSiteDeployments("site_1")).toEqual([
      expect.objectContaining({ id: "deployment_1", status: "active" }),
    ])
  })
})

describe("provider resource ownership and deletion", () => {
  it("never purges adopted/shared resources and prevents ownership rewriting", async () => {
    await makeSite()
    const managed = await recordSiteResource({
      id: "resource_managed",
      siteId: "site_1",
      provider: "cloudflare",
      kind: "worker",
      providerResourceId: "worker_1",
      ownership: "managed",
      dependencies: [],
      now: 100,
    })
    const adopted = await recordSiteResource({
      id: "resource_adopted",
      siteId: "site_1",
      provider: "cloudflare",
      kind: "r2-bucket",
      providerResourceId: "bucket_1",
      ownership: "adopted",
      dependencies: [],
      now: 100,
    })

    expect(await siteResourceCanBePurged(managed.id)).toBe(true)
    expect(await siteResourceCanBePurged(adopted.id)).toBe(false)
    await expect(
      recordSiteResource({ ...managed, ownership: "adopted", now: 200 })
    ).rejects.toThrow("ownership")
  })

  it("distinguishes takedown from metadata deletion and blocks deletion with live resources", async () => {
    await makeSite()
    await setSiteLifecycle("site_1", "taken-down", 200)
    await recordSiteResource({
      id: "resource_1",
      siteId: "site_1",
      provider: "cloudflare",
      kind: "worker",
      providerResourceId: "worker_1",
      ownership: "managed",
      dependencies: [],
      now: 210,
    })

    await expect(deleteSiteProjectMetadata("site_1")).rejects.toThrow("resources")
  })

  it("allows a definite purge failure to return to the retryable taken-down state", async () => {
    await makeSite()
    await setSiteLifecycle("site_1", "taken-down", 200)
    await setSiteLifecycle("site_1", "deleting", 210)
    await expect(setSiteLifecycle("site_1", "taken-down", 220)).resolves.toMatchObject({
      lifecycle: "taken-down",
    })
  })
})
