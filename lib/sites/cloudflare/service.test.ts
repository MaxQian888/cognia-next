/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import {
  completeSiteVersion,
  createSiteDeployment,
  createSiteEnvironmentRevision,
  createSiteProject,
  createSiteVersionDraft,
  getSiteEnvironmentRevision,
  getSiteOperation,
  getSiteProject,
  getSiteVersion,
  claimSiteOperation,
  listSiteDeployments,
  listSiteOperations,
  listSiteResources,
  putSiteArtifact,
  queueSiteOperation,
  recordSiteResource,
  markSiteOperationForReconcile,
  setSiteLifecycle,
} from "@/lib/db/sites"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { KeyringStore } from "@/lib/credentials/keyring-store"
import type { CloudflareSitesClient } from "./client"
import { CloudflareSitesService } from "./service"

class MemoryKeyring implements KeyringStore {
  readonly values = new Map<string, string>()
  async save(key: string, value: string) {
    this.values.set(key, value)
  }
  async load(key: string) {
    return this.values.get(key) ?? null
  }
  async delete(key: string) {
    this.values.delete(key)
  }
}

const client = {
  verifyToken: jest.fn(async () => ({ status: "active" })),
  createD1Database: jest.fn(async () => ({ uuid: "d1-created" })),
  listD1Databases: jest.fn(async (): Promise<Array<{ uuid?: string; name?: string }>> => []),
  deleteD1Database: jest.fn(async () => undefined),
  createR2Bucket: jest.fn(async (_accountId: string, input: { name: string }) => ({
    name: input.name,
  })),
  listR2Buckets: jest.fn(async (): Promise<Array<{ name?: string }>> => []),
  deleteR2Bucket: jest.fn(async () => undefined),
  listVersions: jest.fn(async () => [
    { id: "cf-version-1", annotations: { "workers/tag": "cognia-version_1" } },
  ]),
  deleteVersion: jest.fn(async () => undefined),
  createDeployment: jest.fn(async () => ({ id: "cf-deployment-1" })),
  listDeployments: jest.fn(async (): Promise<unknown[]> => []),
  bulkUpdateSecrets: jest.fn(async () => ({})),
  listDomains: jest.fn(async (): Promise<unknown[]> => []),
  attachDomain: jest.fn(async () => ({ id: "domain-1" })),
  detachDomain: jest.fn(async () => undefined),
  setWorkersDev: jest.fn(async () => undefined),
  getWorkersSubdomain: jest.fn(async () => ({ subdomain: "example" })),
  createAccessApplication: jest.fn(async () => ({ id: "access-app-1" })),
  listAccessApplications: jest.fn(async (): Promise<unknown[]> => []),
  updateAccessApplication: jest.fn(async () => undefined),
  deleteAccessApplication: jest.fn(async () => undefined),
  listAccessPolicies: jest.fn(async () => [] as unknown[]),
  createAccessPolicy: jest.fn(
    async (_accountId: string, _applicationId: string, _input: Record<string, unknown>) => undefined
  ),
  updateAccessPolicy: jest.fn(async () => undefined),
  deleteAccessPolicy: jest.fn(async () => undefined),
  queryWorkerLogs: jest.fn(async () => ({ events: [] })),
  queryWorkerAnalytics: jest.fn(async () => ({ requests: 10 })),
  deleteWorker: jest.fn(async () => undefined),
} satisfies Pick<
  CloudflareSitesClient,
  | "verifyToken"
  | "createD1Database"
  | "listD1Databases"
  | "deleteD1Database"
  | "createR2Bucket"
  | "listR2Buckets"
  | "deleteR2Bucket"
  | "listVersions"
  | "deleteVersion"
  | "createDeployment"
  | "listDeployments"
  | "bulkUpdateSecrets"
  | "listDomains"
  | "attachDomain"
  | "detachDomain"
  | "setWorkersDev"
  | "getWorkersSubdomain"
  | "createAccessApplication"
  | "listAccessApplications"
  | "updateAccessApplication"
  | "deleteAccessApplication"
  | "listAccessPolicies"
  | "createAccessPolicy"
  | "updateAccessPolicy"
  | "deleteAccessPolicy"
  | "queryWorkerLogs"
  | "queryWorkerAnalytics"
  | "deleteWorker"
>

let keyring: MemoryKeyring
let idSequence = 0
let service: CloudflareSitesService

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  jest.clearAllMocks()
  keyring = new MemoryKeyring()
  idSequence = 0
  service = new CloudflareSitesService({
    keyring,
    createClient: () => client,
    uploadVersion: jest.fn(async () => ({
      exitCode: 0,
      stdout: "uploaded",
      stderr: "",
      durationSeconds: 1,
      timedOut: false,
    })),
    writeText: jest.fn(async () => undefined),
    now: () => 1_000 + idSequence,
    newId: (prefix) => `${prefix}_${++idSequence}`,
    leaseOwner: "window-1",
    actorAccountId: "owner",
  })
  await createSiteProject({
    id: "site_1",
    name: "Docs",
    projectId: "project_1",
    sourceRoot: "/repo",
    sourceSubpath: "apps/docs",
    executionTarget: { kind: "local" },
    provider: "cloudflare",
    providerConfig: { accountId: "account-1", workerName: "docs-worker", zoneId: "zone-1" },
    authoringPolicy: { ownerAccountId: "owner", editorAccountIds: [], deployerAccountIds: [] },
    visitorPolicy: { mode: "private" },
    now: 1,
  })
})

async function configureToken() {
  await service.saveProviderToken("site_1", "cf-secret-token")
}

async function readyVersion(secret = true) {
  const environment = await service.saveEnvironment({
    siteId: "site_1",
    variables: { API_ORIGIN: "https://api.example.com" },
    secrets: secret ? { API_TOKEN: "environment-secret" } : {},
  })
  await createSiteVersionDraft({
    id: "version_1",
    siteId: "site_1",
    environmentRevisionId: environment.id,
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
      compatibilityFlags: ["nodejs_compat"],
      routes: [],
      bindings: [],
    },
  })
  await putSiteArtifact({
    digest: "c".repeat(64),
    bytes: new Uint8Array([1, 2, 3]),
    mediaType: "application/gzip",
    fileCount: 2,
  })
  await completeSiteVersion({ versionId: "version_1", artifactDigest: "c".repeat(64) })
  return environment
}

async function queueWaitingOperation(
  id: string,
  type: Parameters<typeof queueSiteOperation>[0]["type"],
  inputPayload: Record<string, unknown>
) {
  await queueSiteOperation({
    id,
    siteId: "site_1",
    type,
    executionTargetKey: "local",
    idempotencyKey: `reconcile:${id}`,
    inputDigest: `digest:${id}`,
    inputPayload,
    now: 2_000 + idSequence++,
  })
  await claimSiteOperation({
    operationId: id,
    leaseOwner: "test-reconcile",
    leaseMs: 1_000,
    now: 3_000,
  })
  await markSiteOperationForReconcile({
    operationId: id,
    leaseOwner: "test-reconcile",
    message: "provider response was uncertain",
    now: 3_001,
  })
}

it("verifies and stores the provider token only in the host keyring", async () => {
  await configureToken()

  expect(client.verifyToken).toHaveBeenCalledTimes(1)
  expect(keyring.values.get("provider:site_1:cloudflare")).toBe("cf-secret-token")
  expect(JSON.stringify(await getSiteProject("site_1"))).not.toContain("cf-secret-token")
})

it("captures immutable environment revisions with secret references, never values", async () => {
  const revision = await service.saveEnvironment({
    siteId: "site_1",
    variables: { PUBLIC_VALUE: "visible" },
    secrets: { PRIVATE_VALUE: "hidden" },
  })

  expect(revision.variables).toEqual({ PUBLIC_VALUE: "visible" })
  expect(revision.secretRefs[0]).toMatchObject({ key: "PRIVATE_VALUE" })
  expect(keyring.values.get(revision.secretRefs[0].credentialId)).toBe("hidden")
  expect(JSON.stringify(await getSiteEnvironmentRevision(revision.id))).not.toContain("hidden")
  expect(
    (
      await getDb()
        .siteOperations.filter((row) => row.type === "environment")
        .first()
    )?.status
  ).toBe("succeeded")
})

it("provisions managed bindings, records adopted ownership, and replays idempotently", async () => {
  await configureToken()
  const bindings = [
    { kind: "d1", name: "DB", resourceName: "docs-db", ownership: "managed" },
    { kind: "r2", name: "FILES", resourceName: "docs-files", ownership: "managed" },
    {
      kind: "r2",
      name: "SHARED_FILES",
      resourceName: "shared-files",
      ownership: "adopted",
      providerResourceId: "existing-bucket",
    },
  ] as const

  const first = await service.provisionBindings("site_1", [...bindings])
  const replay = await service.provisionBindings("site_1", [...bindings])

  expect(first.map((row) => row.ownership)).toEqual(["managed", "managed", "adopted"])
  expect(replay.map((row) => row.id)).toEqual(first.map((row) => row.id))
  expect(client.createD1Database).toHaveBeenCalledTimes(1)
  expect(client.createR2Bucket).toHaveBeenCalledTimes(1)
})

it("uploads a saved version separately, then deploys its captured environment", async () => {
  await configureToken()
  const environment = await readyVersion()

  const providerVersionId = await service.uploadVersion("site_1", "version_1", {
    wranglerBinaryPath: "/opt/cognia/wrangler",
    stagingRoot: "/tmp/cognia-sites/site-1",
    configPath: "/tmp/cognia-sites/site-1/wrangler.json",
    entryPath: "/tmp/cognia-sites/site-1/worker.js",
  })
  const deployed = await service.deployVersion("site_1", "version_1")

  expect(providerVersionId).toBe("cf-version-1")
  expect(client.bulkUpdateSecrets).toHaveBeenCalledWith("account-1", "docs-worker", {
    API_TOKEN: "environment-secret",
  })
  expect(client.createDeployment).toHaveBeenCalledWith(
    "account-1",
    "docs-worker",
    expect.objectContaining({ versionId: "cf-version-1" })
  )
  expect(deployed).toMatchObject({
    environmentRevisionId: environment.id,
    status: "active",
    productionUrl: "https://docs-worker.example.workers.dev",
  })
  expect(await listSiteDeployments("site_1")).toHaveLength(1)
})

it("persists visitor access only after the provider policy converges", async () => {
  await configureToken()
  let policies: unknown[] = []
  client.listAccessPolicies.mockImplementation(async () => policies)
  client.createAccessPolicy.mockImplementation(async (_account, _app, policy) => {
    policies = [{ id: "policy-1", ...policy }]
    return undefined
  })

  const site = await service.reconcileVisitorAccess(
    "site_1",
    { mode: "identities", emails: ["USER@example.com"] },
    "docs.example.com"
  )

  expect(site.visitorPolicy).toEqual({ mode: "identities", emails: ["USER@example.com"] })
  expect(client.createAccessApplication).toHaveBeenCalledTimes(1)
  expect((await listSiteResources("site_1")).some((row) => row.kind === "access-application")).toBe(
    true
  )
})

it("manages custom domains, logs, analytics, takedown, and restore", async () => {
  await configureToken()
  await recordSiteResource({
    id: "site_1:worker:docs-worker",
    siteId: "site_1",
    provider: "cloudflare",
    kind: "worker",
    providerResourceId: "docs-worker",
    ownership: "managed",
    dependencies: [],
  })
  const domain = await service.addDomain("site_1", "Docs.Example.com")
  await expect(service.analytics("site_1", "2026-07-01", "2026-07-18")).resolves.toEqual({
    requests: 10,
  })
  await expect(service.logs("site_1", 1, 2, true)).resolves.toEqual({ events: [] })

  await service.takeDown("site_1")
  expect((await getSiteProject("site_1"))?.lifecycle).toBe("taken-down")
  expect((await listSiteResources("site_1")).find((row) => row.id === domain.id)?.status).toBe(
    "orphaned"
  )

  client.attachDomain.mockResolvedValueOnce({ id: "domain-2" })
  await service.restore("site_1")
  expect((await getSiteProject("site_1"))?.lifecycle).toBe("active")
  expect(client.setWorkersDev).toHaveBeenNthCalledWith(1, "account-1", "docs-worker", false)
  expect(client.setWorkersDev).toHaveBeenNthCalledWith(2, "account-1", "docs-worker", true)
})

it("purges managed resources in dependency order while leaving adopted provider data untouched", async () => {
  await configureToken()
  await recordSiteResource({
    id: "d1",
    siteId: "site_1",
    provider: "cloudflare",
    kind: "d1-database",
    providerResourceId: "managed-db",
    ownership: "managed",
    dependencies: [],
  })
  await recordSiteResource({
    id: "worker",
    siteId: "site_1",
    provider: "cloudflare",
    kind: "worker",
    providerResourceId: "docs-worker",
    ownership: "managed",
    dependencies: ["d1"],
  })
  await recordSiteResource({
    id: "adopted",
    siteId: "site_1",
    provider: "cloudflare",
    kind: "r2-bucket",
    providerResourceId: "external-bucket",
    ownership: "adopted",
    dependencies: [],
  })
  await setSiteLifecycle("site_1", "taken-down")

  await service.purge("site_1")

  expect(client.deleteWorker.mock.invocationCallOrder[0]).toBeLessThan(
    client.deleteD1Database.mock.invocationCallOrder[0]
  )
  expect(client.deleteR2Bucket).not.toHaveBeenCalled()
  expect((await getSiteProject("site_1"))?.lifecycle).toBe("deleted")
  expect((await listSiteResources("site_1")).find((row) => row.id === "adopted")).toMatchObject({
    status: "orphaned",
    ownership: "adopted",
  })
  expect((await listSiteResources("site_1")).filter((row) => row.ownership === "managed")).toEqual(
    expect.arrayContaining([expect.objectContaining({ status: "deleted" })])
  )
})

it("rolls a definite purge failure back for a fresh retry", async () => {
  await configureToken()
  await recordSiteResource({
    id: "worker-retry",
    siteId: "site_1",
    provider: "cloudflare",
    kind: "worker",
    providerResourceId: "docs-worker",
    ownership: "managed",
    dependencies: [],
  })
  await setSiteLifecycle("site_1", "taken-down")
  client.deleteWorker.mockRejectedValueOnce(new Error("provider rejected deletion"))

  await expect(service.purge("site_1")).rejects.toThrow("provider rejected deletion")
  expect((await getSiteProject("site_1"))?.lifecycle).toBe("taken-down")

  await expect(service.purge("site_1")).resolves.toBeUndefined()
  expect((await getSiteProject("site_1"))?.lifecycle).toBe("deleted")
  expect(
    (await listSiteOperations("site_1")).filter((operation) => operation.type === "purge")
  ).toHaveLength(2)
})

it("records an uncertain provider mutation for reconciliation", async () => {
  await configureToken()
  client.createD1Database.mockRejectedValueOnce(new TypeError("network interrupted"))

  await expect(
    service.provisionBindings("site_1", [
      { kind: "d1", name: "DB", resourceName: "docs-db", ownership: "managed" },
    ])
  ).rejects.toThrow("network interrupted")

  const operation = await getDb()
    .siteOperations.filter((row) => row.type === "provision")
    .first()
  expect(await getSiteOperation(operation!.id)).toMatchObject({ status: "waiting-reconcile" })

  client.listD1Databases.mockResolvedValueOnce([{ uuid: "d1-after-timeout", name: "docs-db" }])
  await expect(service.reconcile("site_1")).resolves.toEqual({ resolved: 1, remaining: 0 })
  expect(await getSiteOperation(operation!.id)).toMatchObject({ status: "succeeded" })
  expect(await listSiteResources("site_1")).toEqual([
    expect.objectContaining({
      kind: "d1-database",
      providerResourceId: "d1-after-timeout",
      ownership: "managed",
    }),
  ])
})

it("recovers interrupted local and provider operations without replaying side effects", async () => {
  await createSiteEnvironmentRevision({
    id: "environment_interrupted",
    siteId: "site_1",
    variables: {},
    secretRefs: [],
  })
  await createSiteVersionDraft({
    id: "version_interrupted",
    siteId: "site_1",
    environmentRevisionId: "environment_interrupted",
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
  })
  keyring.values.set("environment:site_1:draft:TOKEN", "secret")
  await queueSiteOperation({
    id: "operation_build",
    siteId: "site_1",
    type: "build",
    executionTargetKey: "local",
    idempotencyKey: "build:interrupted",
    inputDigest: "build-digest",
    inputPayload: { versionId: "version_interrupted" },
  })
  await queueSiteOperation({
    id: "operation_environment",
    siteId: "site_1",
    type: "environment",
    executionTargetKey: "local",
    idempotencyKey: "environment:interrupted",
    inputDigest: "environment-digest",
    inputPayload: {
      secretRefs: [{ credentialId: "environment:site_1:draft:TOKEN" }],
    },
  })
  await queueSiteOperation({
    id: "operation_provider",
    siteId: "site_1",
    type: "domain",
    executionTargetKey: "local",
    idempotencyKey: "domain:interrupted",
    inputDigest: "domain-digest",
    inputPayload: { hostname: "docs.example.com" },
  })

  await expect(service.recoverInterruptedOperations("site_1")).resolves.toBe(3)
  expect(await getSiteVersion("version_interrupted")).toMatchObject({ status: "failed" })
  expect(keyring.values.has("environment:site_1:draft:TOKEN")).toBe(false)
  expect(await getSiteOperation("operation_build")).toMatchObject({ status: "failed" })
  expect(await getSiteOperation("operation_environment")).toMatchObject({ status: "failed" })
  expect(await getSiteOperation("operation_provider")).toMatchObject({
    status: "waiting-reconcile",
  })
  await expect(service.recoverInterruptedOperations("site_1")).resolves.toBe(0)
})

it("reconciles every converged provider mutation without replaying it", async () => {
  await configureToken()
  const environment = await readyVersion(false)
  await createSiteDeployment({
    id: "deployment_reconcile",
    siteId: "site_1",
    versionId: "version_1",
    environmentRevisionId: environment.id,
  })
  client.listDeployments.mockResolvedValueOnce([
    { id: "provider-deployment", versions: [{ version_id: "cf-version-1" }] },
  ])
  client.listDomains.mockResolvedValue([{ id: "provider-domain", hostname: "docs.example.com" }])

  await queueWaitingOperation("operation_upload", "upload", { versionId: "version_1" })
  await queueWaitingOperation("operation_deploy", "deploy", {
    deploymentId: "deployment_reconcile",
    providerVersionId: "cf-version-1",
  })
  await queueWaitingOperation("operation_domain", "domain", {
    hostname: "docs.example.com",
    zoneId: "zone-1",
  })
  await queueWaitingOperation("operation_access", "access", {
    policy: { mode: "public" },
    hostname: "docs.example.com",
  })
  await queueWaitingOperation("operation_takedown", "takedown", { siteId: "site_1" })
  await queueWaitingOperation("operation_restore", "restore", { siteId: "site_1" })

  await expect(service.reconcile("site_1")).resolves.toEqual({ resolved: 6, remaining: 0 })
  expect(client.createDeployment).not.toHaveBeenCalled()
  expect(client.attachDomain).toHaveBeenCalled()
  expect((await getSiteProject("site_1"))?.lifecycle).toBe("active")
  expect((await listSiteDeployments("site_1"))[0]).toMatchObject({
    status: "taken-down",
    providerDeploymentId: "provider-deployment",
  })
})

it("purges every managed Cloudflare resource kind through dependency order", async () => {
  await configureToken()
  const resources = [
    { id: "d1", kind: "d1-database", providerResourceId: "db", dependencies: [] },
    { id: "r2", kind: "r2-bucket", providerResourceId: "bucket", dependencies: [] },
    {
      id: "worker",
      kind: "worker",
      providerResourceId: "docs-worker",
      dependencies: ["d1", "r2"],
    },
    {
      id: "version",
      kind: "worker-version",
      providerResourceId: "version-provider",
      dependencies: ["worker"],
    },
    {
      id: "domain",
      kind: "custom-domain",
      providerResourceId: "domain-provider",
      dependencies: ["worker"],
    },
    {
      id: "secret",
      kind: "secret",
      providerResourceId: "TOKEN",
      dependencies: ["worker"],
    },
    {
      id: "access-app",
      kind: "access-application",
      providerResourceId: "application-provider",
      dependencies: [],
    },
    {
      id: "access-policy",
      kind: "access-policy",
      providerResourceId: "policy-provider",
      dependencies: ["access-app"],
    },
  ] as const
  for (const resource of resources) {
    await recordSiteResource({
      ...resource,
      dependencies: [...resource.dependencies],
      siteId: "site_1",
      provider: "cloudflare",
      ownership: "managed",
    })
  }
  await setSiteLifecycle("site_1", "taken-down")

  await service.purge("site_1")

  expect(client.detachDomain).toHaveBeenCalledWith("account-1", "domain-provider")
  expect(client.deleteAccessPolicy).toHaveBeenCalledWith(
    "account-1",
    "application-provider",
    "policy-provider"
  )
  expect(client.deleteAccessApplication).toHaveBeenCalledWith("account-1", "application-provider")
  expect(client.bulkUpdateSecrets).toHaveBeenCalledWith("account-1", "docs-worker", {
    TOKEN: null,
  })
  expect(client.deleteVersion).toHaveBeenCalledWith("account-1", "docs-worker", "version-provider")
  expect(client.deleteR2Bucket).toHaveBeenCalledWith("account-1", "bucket")
})

it("reconciles domain removal and an existing private Access policy", async () => {
  await configureToken()
  let policies: unknown[] = []
  client.createAccessPolicy.mockImplementation(async (_account, _application, policy) => {
    policies = [{ id: "policy-provider", ...policy }]
    return undefined
  })
  client.listAccessPolicies.mockImplementation(async () => policies)
  await service.reconcileVisitorAccess(
    "site_1",
    { mode: "identities", emails: ["person@example.com"] },
    "docs.example.com"
  )
  client.listAccessApplications.mockResolvedValue([
    { id: "access-app-1", domain: "docs.example.com" },
  ])
  await recordSiteResource({
    id: "domain-remove",
    siteId: "site_1",
    provider: "cloudflare",
    kind: "custom-domain",
    providerResourceId: "provider-domain",
    displayName: "old.example.com",
    ownership: "managed",
    dependencies: [],
  })
  client.listDomains.mockResolvedValue([])
  await queueWaitingOperation("operation_domain_remove", "domain", {
    resourceId: "domain-remove",
  })
  await queueWaitingOperation("operation_access_existing", "access", {
    policy: { mode: "identities", emails: ["person@example.com"] },
    hostname: "docs.example.com",
  })

  await expect(service.reconcile("site_1")).resolves.toEqual({ resolved: 2, remaining: 0 })
  expect(
    (await listSiteResources("site_1")).find((row) => row.id === "domain-remove")
  ).toMatchObject({ status: "deleted" })

  await service.reconcileVisitorAccess("site_1", { mode: "public" }, "docs.example.com")
  expect(client.deleteAccessApplication).toHaveBeenCalledWith("account-1", "access-app-1")
})

it("finishes an interrupted purge only after the dependency graph converges", async () => {
  await configureToken()
  await recordSiteResource({
    id: "worker-reconcile",
    siteId: "site_1",
    provider: "cloudflare",
    kind: "worker",
    providerResourceId: "docs-worker",
    ownership: "managed",
    dependencies: [],
  })
  await recordSiteResource({
    id: "adopted-reconcile",
    siteId: "site_1",
    provider: "cloudflare",
    kind: "r2-bucket",
    providerResourceId: "external-bucket",
    ownership: "adopted",
    dependencies: [],
  })
  await queueWaitingOperation("operation_purge", "purge", { siteId: "site_1" })
  await setSiteLifecycle("site_1", "taken-down")
  await setSiteLifecycle("site_1", "deleting")

  await expect(service.reconcile("site_1")).resolves.toEqual({ resolved: 1, remaining: 0 })
  expect((await getSiteProject("site_1"))?.lifecycle).toBe("deleted")
  expect(client.deleteWorker).toHaveBeenCalled()
  expect(client.deleteR2Bucket).not.toHaveBeenCalled()
})

it("rejects invalid provider, environment, binding, domain, and lifecycle inputs", async () => {
  await expect(service.saveProviderToken("site_1", "   ")).rejects.toThrow(
    "Cloudflare provider token is required"
  )
  client.verifyToken.mockResolvedValueOnce({ status: "disabled" })
  await expect(service.saveProviderToken("site_1", "inactive-token")).rejects.toThrow(
    "Cloudflare provider token is not active"
  )
  await expect(
    service.saveEnvironment({
      siteId: "site_1",
      variables: { DUPLICATE: "plain" },
      secrets: { DUPLICATE: "secret" },
    })
  ).rejects.toThrow("environment key cannot be both plain and secret")
  await expect(
    service.saveEnvironment({ siteId: "site_1", variables: { "not-valid": "x" }, secrets: {} })
  ).rejects.toThrow("environment keys must be JavaScript identifiers")

  await configureToken()
  await expect(
    service.provisionBindings("site_1", [
      { kind: "r2", name: "FILES", resourceName: "shared", ownership: "shared" },
    ])
  ).rejects.toThrow("requires a provider resource id")
  await expect(service.addDomain("site_1", "https://bad.example.com")).rejects.toThrow(
    "custom domain hostname is invalid"
  )
  await expect(service.removeDomain("site_1", "missing-domain")).rejects.toThrow(
    "Site custom domain not found"
  )
  await expect(service.purge("site_1")).rejects.toThrow("Site must be taken down before purge")
})
