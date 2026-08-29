import { nanoid } from "nanoid"

import { canonicalStringify } from "@/lib/data/migrate"
import {
  claimNextSiteOperation,
  claimSiteOperation,
  completeSiteOperation,
  createSiteDeployment,
  createSiteEnvironmentRevision,
  failSiteDeployment,
  failSiteOperation,
  failSiteVersion,
  getSiteArtifact,
  getSiteDeployment,
  getSiteEnvironmentRevision,
  getSiteProject,
  getSiteResource,
  getSiteVersion,
  listSiteDeployments,
  listSiteEnvironmentRevisions,
  listSiteOperations,
  listSiteResources,
  markSiteDeploymentActive,
  markSiteDeploymentsTakenDown,
  markSiteOperationForReconcile,
  queueSiteOperation,
  recordSiteResource,
  resolveSiteOperationFromReconcile,
  setSiteLifecycle,
  setSiteProviderTokenState,
  setSiteResourceStatus,
  siteResourceCanBePurged,
  updateSiteVisitorPolicy,
} from "@/lib/db/sites"
import { createLocalKeyringStore, type KeyringStore } from "@/lib/credentials/keyring-store"
import { sha256Hex } from "@/lib/share/hash"
import { writeTextFile } from "@/lib/file/file-operations"
import { assertSiteAuthoringCapability } from "@/lib/sites/authoring-policy"
import { latestEnvironmentRevision } from "@/lib/sites/console-model"
import {
  parseSiteWorkerAnalytics,
  parseSiteWorkerLogs,
  type SiteAnalyticsView,
  type SiteLogsView,
} from "./observability-parse"
import type { SiteHostingManifest } from "@/lib/sites/manifest"
import type {
  SiteEnvironmentRevisionRow,
  SiteOperationType,
  SiteProjectRow,
  SiteResourceKind,
  SiteResourceRow,
  SiteSecretEdit,
  SiteSecretReference,
  SiteVisitorPolicy,
} from "@/types/sites"
import {
  CloudflareSitesClient,
  CloudflareSitesError,
  type CloudflareSitesClientOptions,
} from "./client"
import {
  cloudflareAccessPolicyMatches,
  compileCloudflareAccessPolicy,
  type CloudflareAccessPolicySpec,
} from "./access-policy"
import {
  uploadCloudflareWorkerVersion,
  type CloudflareVersionUploadInput,
  type CloudflareVersionUploadResult,
} from "./version-uploader"

type CloudflareClient = Pick<
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

interface CloudflareSitesServiceDeps {
  keyring: KeyringStore
  createClient: (options: CloudflareSitesClientOptions) => CloudflareClient
  uploadVersion: (input: CloudflareVersionUploadInput) => Promise<CloudflareVersionUploadResult>
  writeText: (path: string, contents: string) => Promise<void>
  now: () => number
  newId: (prefix: string) => string
  leaseOwner: string
  actorAccountId: string
}

export interface SiteVersionUploadPaths {
  wranglerBinaryPath: string
  stagingRoot: string
  configPath: string
  entryPath: string
  assetsPath?: string
}

function defaultDeps(keyring?: KeyringStore): CloudflareSitesServiceDeps {
  return {
    keyring: keyring ?? createLocalKeyringStore("cognia-sites"),
    createClient: (options) => new CloudflareSitesClient(options),
    uploadVersion: uploadCloudflareWorkerVersion,
    writeText: writeTextFile,
    now: Date.now,
    newId: (prefix) => `${prefix}_${nanoid()}`,
    leaseOwner: `sites-window-${nanoid()}`,
    actorAccountId: "local-user",
  }
}

function providerTokenKey(siteId: string): string {
  return `provider:${siteId}:cloudflare`
}

function resourceId(siteId: string, kind: SiteResourceKind, providerId: string): string {
  return `${siteId}:${kind}:${encodeURIComponent(providerId)}`
}

function objectId(value: unknown, label: string): string {
  if (!value || typeof value !== "object") throw new Error(`${label} response is invalid`)
  const id =
    (value as { id?: unknown; uuid?: unknown }).id ??
    (value as { id?: unknown; uuid?: unknown }).uuid
  if (typeof id !== "string" || !id.trim()) throw new Error(`${label} response has no id`)
  return id
}

function mutationOutcomeIsUncertain(error: unknown): boolean {
  if (error instanceof CloudflareSitesError) {
    return error.status === 408 || error.status === 429 || error.status >= 500
  }
  return error instanceof TypeError
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function versionProviderId(versions: unknown[], tag: string): string | undefined {
  for (const value of versions) {
    if (!value || typeof value !== "object") continue
    const row = value as {
      id?: unknown
      tag?: unknown
      annotations?: Record<string, unknown>
      metadata?: { annotations?: Record<string, unknown> }
    }
    const actualTag =
      row.tag ?? row.annotations?.["workers/tag"] ?? row.metadata?.annotations?.["workers/tag"]
    if (actualTag === tag && typeof row.id === "string") return row.id
  }
  return undefined
}

function accessPolicy(value: unknown): CloudflareAccessPolicySpec & { id?: string } {
  if (!value || typeof value !== "object") throw new Error("Cloudflare Access policy is invalid")
  const row = value as Record<string, unknown>
  if (typeof row.name !== "string" || row.decision !== "allow" || !Array.isArray(row.include)) {
    throw new Error("Cloudflare Access policy is invalid")
  }
  return {
    ...(typeof row.id === "string" ? { id: row.id } : {}),
    name: row.name,
    decision: "allow",
    include: row.include as CloudflareAccessPolicySpec["include"],
  }
}

async function requiredSite(siteId: string): Promise<SiteProjectRow> {
  const site = await getSiteProject(siteId)
  if (!site || site.lifecycle === "deleted" || site.lifecycle === "deleting") {
    throw new Error("active site project not found")
  }
  if ((site.executionTarget as { kind?: unknown }).kind !== "local") {
    throw new Error("Sites provider operations require the selected local execution host")
  }
  return site
}

export class CloudflareSitesService {
  private readonly deps: CloudflareSitesServiceDeps

  constructor(deps?: Partial<CloudflareSitesServiceDeps>) {
    this.deps = { ...defaultDeps(deps?.keyring), ...deps }
  }

  private async client(
    siteId: string,
    allowDeleting = false
  ): Promise<{ site: SiteProjectRow; client: CloudflareClient }> {
    const site = allowDeleting ? await getSiteProject(siteId) : await requiredSite(siteId)
    if (!site || site.lifecycle === "deleted") throw new Error("Site project not found")
    if ((site.executionTarget as { kind?: unknown }).kind !== "local") {
      throw new Error("Sites provider operations require the selected local execution host")
    }
    const token = await this.deps.keyring.load(providerTokenKey(siteId))
    if (!token) throw new Error("Cloudflare provider token is not configured on this host")
    return { site, client: this.deps.createClient({ token }) }
  }

  /**
   * How long an operation may hold its lease before recovery may reclaim it.
   *
   * Uploading a large artifact through wrangler routinely exceeds ten minutes,
   * which was the previous value for everything. A lease shorter than the work
   * it protects is not a safety mechanism: recovery sees `running` with an
   * expired lease, terminates it, and the live call then fails at
   * `completeSiteOperation` on a lease-owner mismatch — with the provider-side
   * effect already applied. The long operations get a window that actually
   * covers them; everything else keeps the tighter one so a genuinely dead
   * claim is reclaimed promptly.
   */
  private leaseMsFor(type: SiteOperationType): number {
    return type === "build" || type === "upload" ? 60 * 60 * 1000 : 10 * 60 * 1000
  }

  private async runOperation<T>(input: {
    site: SiteProjectRow
    type: SiteOperationType
    idempotencyKey: string
    payload: unknown
    action: () => Promise<T>
    replay?: () => Promise<T>
  }): Promise<T> {
    const inputDigest = await sha256Hex(canonicalStringify(input.payload))
    const queued = await queueSiteOperation({
      id: this.deps.newId("siteop"),
      siteId: input.site.id,
      type: input.type,
      executionTargetKey: input.site.executionTargetKey,
      idempotencyKey: input.idempotencyKey,
      inputDigest,
      inputPayload: input.payload,
      now: this.deps.now(),
    })
    if (queued.status === "succeeded") {
      if (input.replay) return input.replay()
      throw new Error("Site operation already succeeded; refresh the current Site state")
    }
    if (queued.status !== "queued" && queued.status !== "running") {
      throw new Error(`Site operation requires reconciliation: ${queued.status}`)
    }
    await claimSiteOperation({
      operationId: queued.id,
      leaseOwner: this.deps.leaseOwner,
      leaseMs: this.leaseMsFor(input.type),
      now: this.deps.now(),
    })
    try {
      const value = await input.action()
      await completeSiteOperation({
        operationId: queued.id,
        leaseOwner: this.deps.leaseOwner,
        now: this.deps.now(),
      })
      return value
    } catch (error) {
      const update = mutationOutcomeIsUncertain(error)
        ? markSiteOperationForReconcile({
            operationId: queued.id,
            leaseOwner: this.deps.leaseOwner,
            message: errorMessage(error),
            now: this.deps.now(),
          })
        : failSiteOperation({
            operationId: queued.id,
            leaseOwner: this.deps.leaseOwner,
            message: errorMessage(error),
            now: this.deps.now(),
          })
      await update
      throw error
    }
  }

  async saveProviderToken(siteId: string, token: string): Promise<void> {
    const site = await requiredSite(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "manage")
    if (!token.trim()) throw new Error("Cloudflare provider token is required")
    const client = this.deps.createClient({ token })
    let verification: { status: string }
    try {
      verification = await client.verifyToken()
    } catch (error) {
      await setSiteProviderTokenState(site.id, {
        executionTargetKey: site.executionTargetKey,
        status: "rejected",
        lastFailureAt: this.deps.now(),
      })
      throw error
    }
    if (verification.status !== "active") {
      await setSiteProviderTokenState(site.id, {
        executionTargetKey: site.executionTargetKey,
        status: "rejected",
        lastFailureAt: this.deps.now(),
      })
      throw new Error("Cloudflare provider token is not active")
    }
    await this.deps.keyring.save(providerTokenKey(site.id), token)
    // The console has no other way to ask "is a credential configured on this
    // host" — the keyring cannot be enumerated and the token must never come
    // back out for a UI check.
    await setSiteProviderTokenState(site.id, {
      executionTargetKey: site.executionTargetKey,
      status: "verified",
      verifiedAt: this.deps.now(),
    })
  }

  /**
   * Write a new environment revision.
   *
   * `secrets` is a list of edits, not a value map, because the editor cannot
   * seed itself from the keyring: a secret's value is unreadable by design. The
   * previous shape took only newly typed values, so saving a variable change
   * dropped every configured secret from the new revision and the next publish
   * pushed a worker without them. A `keep` carries the previous reference
   * forward verbatim — `credentialId` is revision-scoped and old entries are
   * never deleted, so both revisions stay resolvable.
   */
  async saveEnvironment(input: {
    siteId: string
    variables: Record<string, string>
    secrets: readonly SiteSecretEdit[]
  }): Promise<SiteEnvironmentRevisionRow> {
    const site = await requiredSite(input.siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "edit")
    const edits = input.secrets.filter((edit) => edit.action !== "remove")
    const variableKeys = Object.keys(input.variables)
    const secretKeys = edits.map((edit) => edit.key)
    const keys = [...variableKeys, ...secretKeys]
    if (new Set(keys).size !== keys.length)
      throw new Error("environment key cannot be both plain and secret")
    if (keys.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) {
      throw new Error("environment keys must be JavaScript identifiers")
    }

    const previous = latestEnvironmentRevision(await listSiteEnvironmentRevisions(site.id))
    const carried = new Map(previous?.secretRefs.map((ref) => [ref.key, ref]) ?? [])
    const revisionId = this.deps.newId("siteenv")

    const secretRefs: SiteSecretReference[] = []
    const minted: Array<{ credentialId: string; value: string }> = []
    for (const edit of [...edits].sort((left, right) => left.key.localeCompare(right.key))) {
      if (edit.action === "keep") {
        const existing = carried.get(edit.key)
        if (!existing) throw new Error(`no stored secret to keep for ${edit.key}`)
        secretRefs.push(existing)
        continue
      }
      const credentialId = `environment:${site.id}:${revisionId}:${edit.key}`
      secretRefs.push({ key: edit.key, credentialId, revision: this.deps.newId("secret") })
      minted.push({ credentialId, value: edit.value })
    }

    const saved: string[] = []
    try {
      for (const credential of minted) {
        await this.deps.keyring.save(credential.credentialId, credential.value)
        saved.push(credential.credentialId)
      }
      return await this.runOperation({
        site,
        type: "environment",
        idempotencyKey: `environment:${site.id}:${revisionId}`,
        payload: { variables: input.variables, secretKeys: secretKeys.sort(), secretRefs },
        action: () =>
          createSiteEnvironmentRevision({
            id: revisionId,
            siteId: site.id,
            variables: input.variables,
            secretRefs,
            now: this.deps.now(),
          }),
      })
    } catch (error) {
      await Promise.all(saved.map((key) => this.deps.keyring.delete(key)))
      throw error
    }
  }

  async recoverInterruptedOperations(siteId: string): Promise<number> {
    const site = await requiredSite(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "manage")
    let recovered = 0
    for (;;) {
      const operation = await claimNextSiteOperation({
        executionTargetKey: site.executionTargetKey,
        siteId: site.id,
        leaseOwner: this.deps.leaseOwner,
        leaseMs: 10 * 60 * 1000,
        now: this.deps.now(),
      })
      if (!operation) break
      const payload =
        operation.inputPayload && typeof operation.inputPayload === "object"
          ? (operation.inputPayload as Record<string, unknown>)
          : {}
      if (operation.type === "build") {
        if (typeof payload.versionId === "string") {
          await failSiteVersion(
            payload.versionId,
            "Build was interrupted when the desktop host stopped",
            this.deps.now()
          )
        }
        await failSiteOperation({
          operationId: operation.id,
          leaseOwner: this.deps.leaseOwner,
          message: "Build was interrupted; create a new immutable Site version",
          now: this.deps.now(),
        })
      } else if (operation.type === "environment") {
        const references = Array.isArray(payload.secretRefs) ? payload.secretRefs : []
        await Promise.all(
          references.map((reference) => {
            const credentialId =
              reference && typeof reference === "object"
                ? (reference as { credentialId?: unknown }).credentialId
                : undefined
            return typeof credentialId === "string"
              ? this.deps.keyring.delete(credentialId)
              : Promise.resolve()
          })
        )
        await failSiteOperation({
          operationId: operation.id,
          leaseOwner: this.deps.leaseOwner,
          message: "Environment save was interrupted; secret drafts were removed",
          now: this.deps.now(),
        })
      } else {
        await markSiteOperationForReconcile({
          operationId: operation.id,
          leaseOwner: this.deps.leaseOwner,
          message: "Desktop host stopped during a provider mutation",
          now: this.deps.now(),
        })
      }
      recovered += 1
    }
    return recovered
  }

  async provisionBindings(
    siteId: string,
    bindings: SiteHostingManifest["cloudflare"]["bindings"]
  ): Promise<SiteResourceRow[]> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "deploy")
    const output: SiteResourceRow[] = []
    for (const binding of bindings) {
      if (binding.ownership !== "managed" && !binding.providerResourceId) {
        throw new Error(`adopted/shared binding ${binding.name} requires a provider resource id`)
      }
      const row = await this.runOperation({
        site,
        type: "provision",
        idempotencyKey: `provision:${site.id}:${binding.kind}:${binding.name}:${binding.resourceName}`,
        payload: binding,
        replay: async () => {
          const existing = (await listSiteResources(site.id)).find(
            (resource) =>
              resource.metadata?.bindingName === binding.name &&
              resource.kind === (binding.kind === "d1" ? "d1-database" : "r2-bucket")
          )
          if (!existing) throw new Error("completed Site binding operation has no resource record")
          return existing
        },
        action: async () => {
          let providerId = binding.providerResourceId
          if (!providerId && binding.kind === "d1") {
            providerId = objectId(
              await client.createD1Database(site.providerConfig.accountId, {
                name: binding.resourceName,
              }),
              "Cloudflare D1"
            )
          }
          if (!providerId && binding.kind === "r2") {
            const created = await client.createR2Bucket(site.providerConfig.accountId, {
              name: binding.resourceName,
            })
            providerId = typeof created.name === "string" ? created.name : binding.resourceName
          }
          if (!providerId) throw new Error("Cloudflare resource id is missing")
          return recordSiteResource({
            id: resourceId(
              site.id,
              binding.kind === "d1" ? "d1-database" : "r2-bucket",
              providerId
            ),
            siteId: site.id,
            provider: "cloudflare",
            kind: binding.kind === "d1" ? "d1-database" : "r2-bucket",
            providerResourceId: providerId,
            displayName: binding.resourceName,
            metadata: { bindingName: binding.name },
            ownership: binding.ownership,
            dependencies: [],
            now: this.deps.now(),
          })
        },
      })
      output.push(row)
    }
    return output
  }

  private async loadSecrets(
    environment: SiteEnvironmentRevisionRow
  ): Promise<Record<string, string>> {
    const values: Record<string, string> = {}
    for (const reference of environment.secretRefs) {
      const value = await this.deps.keyring.load(reference.credentialId)
      if (value === null) throw new Error(`secret ${reference.key} is unavailable on this host`)
      values[reference.key] = value
    }
    return values
  }

  async uploadVersion(
    siteId: string,
    versionId: string,
    paths: SiteVersionUploadPaths
  ): Promise<string> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "deploy")
    const version = await getSiteVersion(versionId)
    if (
      !version ||
      version.siteId !== site.id ||
      version.status !== "ready" ||
      !version.artifactDigest
    ) {
      throw new Error("ready Site version not found")
    }
    if (!(await getSiteArtifact(version.artifactDigest)))
      throw new Error("Site version artifact not found")
    const environment = await getSiteEnvironmentRevision(version.environmentRevisionId)
    if (!environment) throw new Error("Site environment revision not found")
    const resources = await listSiteResources(site.id)
    const bindingResources = resources.filter((row) =>
      ["d1-database", "r2-bucket"].includes(row.kind)
    )
    const config = {
      $schema: "node_modules/wrangler/config-schema.json",
      name: site.providerConfig.workerName,
      main: paths.entryPath,
      compatibility_date: version.build.compatibilityDate,
      compatibility_flags: version.build.compatibilityFlags,
      // Recorded on the version since the manifest gained `cloudflare.routes`,
      // and only emitted when there are any — wrangler treats an empty `routes`
      // array as "detach every route", which is not what "none configured"
      // means.
      // Wrangler's plain-pattern form, which infers the zone from the pattern.
      ...(version.build.routes.length > 0 ? { routes: version.build.routes } : {}),
      vars: environment.variables,
      d1_databases: bindingResources
        .filter((row) => row.kind === "d1-database")
        .map((row) => ({
          binding: row.metadata?.bindingName,
          database_name: row.displayName,
          database_id: row.providerResourceId,
        })),
      r2_buckets: bindingResources
        .filter((row) => row.kind === "r2-bucket")
        .map((row) => ({ binding: row.metadata?.bindingName, bucket_name: row.displayName })),
    }
    await this.deps.writeText(paths.configPath, JSON.stringify(config, null, 2))
    const tag = `cognia-${version.id}`
    return this.runOperation({
      site,
      type: "upload",
      idempotencyKey: `upload:${site.id}:${version.id}:${version.artifactDigest}`,
      payload: { versionId, artifactDigest: version.artifactDigest, config },
      replay: async () => {
        const existing = (await listSiteResources(site.id)).find(
          (row) => row.kind === "worker-version" && row.displayName === version.id
        )
        if (!existing) throw new Error("completed Site upload has no provider version record")
        return existing.providerResourceId
      },
      action: async () => {
        const token = await this.deps.keyring.load(providerTokenKey(site.id))
        if (!token) throw new Error("Cloudflare provider token is not configured on this host")
        const result = await this.deps.uploadVersion({
          ...paths,
          workerName: site.providerConfig.workerName,
          accountId: site.providerConfig.accountId,
          apiToken: token,
          tag,
          message: `Cognia Sites version ${version.sequence}`,
          compatibilityDate: version.build.compatibilityDate,
          compatibilityFlags: version.build.compatibilityFlags,
        })
        if (result.timedOut) throw new TypeError("Cloudflare version upload timed out")
        if (result.exitCode !== 0)
          throw new Error(result.stderr || "Cloudflare version upload failed")
        const providerId = versionProviderId(
          await client.listVersions(site.providerConfig.accountId, site.providerConfig.workerName),
          tag
        )
        if (!providerId)
          throw new TypeError(
            "Cloudflare accepted the upload but the saved version is not yet visible"
          )
        const bindingIds = bindingResources.map((row) => row.id)
        const worker = await recordSiteResource({
          id: resourceId(site.id, "worker", site.providerConfig.workerName),
          siteId: site.id,
          provider: "cloudflare",
          kind: "worker",
          providerResourceId: site.providerConfig.workerName,
          displayName: site.providerConfig.workerName,
          ownership: "managed",
          dependencies: bindingIds,
          now: this.deps.now(),
        })
        await recordSiteResource({
          id: resourceId(site.id, "worker-version", providerId),
          siteId: site.id,
          provider: "cloudflare",
          kind: "worker-version",
          providerResourceId: providerId,
          displayName: version.id,
          metadata: { artifactDigest: version.artifactDigest! },
          ownership: "managed",
          dependencies: [worker.id, ...bindingIds],
          now: this.deps.now(),
        })
        return providerId
      },
    })
  }

  async deployVersion(
    siteId: string,
    versionId: string
  ): Promise<ReturnType<typeof markSiteDeploymentActive> extends Promise<infer T> ? T : never> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "deploy")
    const version = await getSiteVersion(versionId)
    if (!version || version.siteId !== site.id || version.status !== "ready") {
      throw new Error("ready Site version not found")
    }
    const environment = await getSiteEnvironmentRevision(version.environmentRevisionId)
    if (!environment) throw new Error("Site environment revision not found")
    const versionResource = (await listSiteResources(site.id)).find(
      (row) =>
        row.kind === "worker-version" && row.displayName === version.id && row.status === "active"
    )
    if (!versionResource) throw new Error("Site version must be uploaded before deployment")
    const deployment = await createSiteDeployment({
      id: this.deps.newId("sitedeploy"),
      siteId: site.id,
      versionId: version.id,
      environmentRevisionId: environment.id,
      now: this.deps.now(),
    })
    try {
      return await this.runOperation({
        site,
        type: "deploy",
        idempotencyKey: `deploy:${site.id}:${version.id}:${deployment.id}`,
        payload: {
          versionId: version.id,
          environmentRevisionId: environment.id,
          deploymentId: deployment.id,
          providerVersionId: versionResource.providerResourceId,
        },
        action: async () => {
          const secrets = await this.loadSecrets(environment)
          const activeSecrets = (await listSiteResources(site.id)).filter(
            (row) => row.kind === "secret" && row.status === "active"
          )
          const secretUpdates: Record<string, string | null> = { ...secrets }
          for (const resource of activeSecrets) {
            if (!Object.hasOwn(secrets, resource.providerResourceId)) {
              secretUpdates[resource.providerResourceId] = null
            }
          }
          if (Object.keys(secretUpdates).length > 0) {
            await client.bulkUpdateSecrets(
              site.providerConfig.accountId,
              site.providerConfig.workerName,
              secretUpdates
            )
          }
          for (const resource of activeSecrets) {
            if (!Object.hasOwn(secrets, resource.providerResourceId)) {
              await setSiteResourceStatus(resource.id, "deleted", this.deps.now())
            }
          }
          for (const key of Object.keys(secrets)) {
            await recordSiteResource({
              id: resourceId(site.id, "secret", key),
              siteId: site.id,
              provider: "cloudflare",
              kind: "secret",
              providerResourceId: key,
              displayName: key,
              ownership: "managed",
              dependencies: [resourceId(site.id, "worker", site.providerConfig.workerName)],
              now: this.deps.now(),
            })
          }
          const provider = await client.createDeployment(
            site.providerConfig.accountId,
            site.providerConfig.workerName,
            {
              versionId: versionResource.providerResourceId,
              message: `Cognia Sites version ${version.sequence}`,
            }
          )
          const subdomain = await client.getWorkersSubdomain(site.providerConfig.accountId)
          return markSiteDeploymentActive({
            deploymentId: deployment.id,
            providerDeploymentId: provider.id,
            productionUrl: `https://${site.providerConfig.workerName}.${subdomain.subdomain}.workers.dev`,
            now: this.deps.now(),
          })
        },
      })
    } catch (error) {
      if (!mutationOutcomeIsUncertain(error)) {
        await failSiteDeployment(deployment.id, errorMessage(error), this.deps.now())
      }
      throw error
    }
  }

  async reconcileVisitorAccess(
    siteId: string,
    policy: SiteVisitorPolicy,
    hostname: string
  ): Promise<SiteProjectRow> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "manage")
    const desired = compileCloudflareAccessPolicy(policy)
    const resources = await listSiteResources(site.id)
    const application = resources.find(
      (row) => row.kind === "access-application" && row.status === "active"
    )
    return this.runOperation({
      site,
      type: "access",
      idempotencyKey: `access:${site.id}:${await sha256Hex(canonicalStringify({ policy, hostname }))}`,
      payload: { policy, hostname },
      replay: async () => {
        const current = await getSiteProject(site.id)
        if (!current) throw new Error("site project not found")
        return current
      },
      action: async () => {
        if (!desired.applicationRequired) {
          if (application && application.ownership === "managed") {
            await client.deleteAccessApplication(
              site.providerConfig.accountId,
              application.providerResourceId
            )
            for (const policyResource of resources.filter(
              (row) => row.kind === "access-policy" && row.status === "active"
            )) {
              await setSiteResourceStatus(policyResource.id, "deleted", this.deps.now())
            }
            await setSiteResourceStatus(application.id, "deleted", this.deps.now())
          }
          return updateSiteVisitorPolicy(site.id, policy, this.deps.now())
        }
        const appBody = {
          name: `${site.name} — Cognia Sites`,
          domain: hostname,
          type: "self_hosted",
          session_duration: "24h",
          auto_redirect_to_identity: false,
        }
        let appId = application?.providerResourceId
        let appResourceId = application?.id
        if (appId) {
          await client.updateAccessApplication(site.providerConfig.accountId, appId, appBody)
        } else {
          appId = objectId(
            await client.createAccessApplication(site.providerConfig.accountId, appBody),
            "Cloudflare Access application"
          )
          await recordSiteResource({
            id: resourceId(site.id, "access-application", appId),
            siteId: site.id,
            provider: "cloudflare",
            kind: "access-application",
            providerResourceId: appId,
            displayName: hostname,
            ownership: "managed",
            dependencies: [],
            now: this.deps.now(),
          })
          appResourceId = resourceId(site.id, "access-application", appId)
        }
        const actual = (await client.listAccessPolicies(site.providerConfig.accountId, appId)).map(
          accessPolicy
        )
        const wanted = desired.policies
        for (let index = 0; index < Math.max(actual.length, wanted.length); index += 1) {
          const current = actual[index]
          const next = wanted[index]
          if (current && next) {
            await client.updateAccessPolicy(
              site.providerConfig.accountId,
              appId,
              current.id ?? "",
              { ...next }
            )
          } else if (next) {
            await client.createAccessPolicy(site.providerConfig.accountId, appId, { ...next })
          } else if (current?.id) {
            await client.deleteAccessPolicy(site.providerConfig.accountId, appId, current.id)
          }
        }
        const verified = (
          await client.listAccessPolicies(site.providerConfig.accountId, appId)
        ).map(accessPolicy)
        if (!cloudflareAccessPolicyMatches(desired, verified)) {
          throw new TypeError("Cloudflare Access policy has not converged")
        }
        const verifiedIds = new Set<string>()
        for (const policy of verified) {
          if (!policy.id) throw new TypeError("Cloudflare Access policy has no provider id")
          verifiedIds.add(policy.id)
          await recordSiteResource({
            id: resourceId(site.id, "access-policy", policy.id),
            siteId: site.id,
            provider: "cloudflare",
            kind: "access-policy",
            providerResourceId: policy.id,
            displayName: policy.name,
            ownership: "managed",
            dependencies: appResourceId ? [appResourceId] : [],
            now: this.deps.now(),
          })
        }
        for (const policyResource of resources.filter(
          (row) => row.kind === "access-policy" && row.status === "active"
        )) {
          if (!verifiedIds.has(policyResource.providerResourceId)) {
            await setSiteResourceStatus(policyResource.id, "deleted", this.deps.now())
          }
        }
        return updateSiteVisitorPolicy(site.id, policy, this.deps.now())
      },
    })
  }

  async addDomain(siteId: string, hostname: string, zoneId?: string): Promise<SiteResourceRow> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "manage")
    const zone = zoneId ?? site.providerConfig.zoneId
    if (!zone) throw new Error("Cloudflare zone id is required for a custom domain")
    const normalized = hostname.trim().toLowerCase()
    if (!normalized || normalized.includes(":") || normalized.includes("/"))
      throw new Error("custom domain hostname is invalid")
    const domainHistory = (await listSiteResources(site.id)).filter(
      (row) => row.kind === "custom-domain" && row.displayName === normalized
    )
    const activeDomain = domainHistory.find((row) => row.status === "active")
    if (activeDomain) return activeDomain
    return this.runOperation({
      site,
      type: "domain",
      idempotencyKey: `domain:add:${site.id}:${normalized}:${domainHistory.length}`,
      payload: { hostname: normalized, zoneId: zone },
      replay: async () => {
        const existing = (await listSiteResources(site.id)).find(
          (row) =>
            row.kind === "custom-domain" &&
            row.displayName === normalized &&
            row.status === "active"
        )
        if (!existing) throw new Error("completed Site domain operation has no resource record")
        return existing
      },
      action: async () => {
        const domain = await client.attachDomain(site.providerConfig.accountId, {
          zoneId: zone,
          hostname: normalized,
          workerName: site.providerConfig.workerName,
        })
        return recordSiteResource({
          id: resourceId(site.id, "custom-domain", domain.id),
          siteId: site.id,
          provider: "cloudflare",
          kind: "custom-domain",
          providerResourceId: domain.id,
          displayName: normalized,
          metadata: { zoneId: zone },
          ownership: "managed",
          dependencies: [resourceId(site.id, "worker", site.providerConfig.workerName)],
          now: this.deps.now(),
        })
      },
    })
  }

  async removeDomain(siteId: string, resourceRowId: string): Promise<void> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "manage")
    const resource = await getSiteResource(resourceRowId)
    if (!resource || resource.siteId !== site.id || resource.kind !== "custom-domain") {
      throw new Error("Site custom domain not found")
    }
    await this.runOperation({
      site,
      type: "domain",
      idempotencyKey: `domain:remove:${site.id}:${resource.id}`,
      payload: { resourceId: resource.id },
      replay: async () => undefined,
      action: async () => {
        await client.detachDomain(site.providerConfig.accountId, resource.providerResourceId)
        await setSiteResourceStatus(resource.id, "deleted", this.deps.now())
      },
    })
  }

  /**
   * Worker (and, with a zone and a hostname, zone) analytics for a window.
   *
   * Parsed at this boundary rather than returned as `unknown`: the console had
   * no way to render a number it could not name, so it rendered the payload.
   */
  async analytics(siteId: string, from: string, to: string): Promise<SiteAnalyticsView> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "view")
    const domains = (await listSiteResources(site.id)).filter(
      (row) => row.kind === "custom-domain" && row.status === "active" && row.displayName
    )
    const deployments = await listSiteDeployments(site.id)
    const hostname =
      domains[0]?.displayName ??
      (() => {
        try {
          return deployments[0]?.productionUrl
            ? new URL(deployments[0].productionUrl).hostname
            : undefined
        } catch {
          return undefined
        }
      })()
    return parseSiteWorkerAnalytics(
      await client.queryWorkerAnalytics(site.providerConfig.accountId, {
        workerName: site.providerConfig.workerName,
        from,
        to,
        zoneId: site.providerConfig.zoneId,
        hostname,
      })
    )
  }

  async logs(siteId: string, from: number, to: number, errorsOnly = false): Promise<SiteLogsView> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "view")
    return parseSiteWorkerLogs(
      await client.queryWorkerLogs(site.providerConfig.accountId, {
        workerName: site.providerConfig.workerName,
        from,
        to,
        errorsOnly,
      })
    )
  }

  async takeDown(siteId: string): Promise<void> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "manage")
    if (site.lifecycle === "taken-down") return
    await this.runOperation({
      site,
      type: "takedown",
      idempotencyKey: `takedown:${site.id}`,
      payload: { siteId: site.id },
      replay: async () => undefined,
      action: async () => {
        await client.setWorkersDev(
          site.providerConfig.accountId,
          site.providerConfig.workerName,
          false
        )
        const domains = (await listSiteResources(site.id)).filter(
          (row) => row.kind === "custom-domain" && row.status === "active"
        )
        for (const domain of domains) {
          await client.detachDomain(site.providerConfig.accountId, domain.providerResourceId)
          await setSiteResourceStatus(domain.id, "orphaned", this.deps.now())
        }
        await markSiteDeploymentsTakenDown(site.id, this.deps.now())
        await setSiteLifecycle(site.id, "taken-down", this.deps.now())
      },
    })
  }

  async restore(siteId: string): Promise<void> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "manage")
    if (site.lifecycle !== "taken-down") throw new Error("only a taken-down Site can be restored")
    await this.runOperation({
      site,
      type: "restore",
      idempotencyKey: `restore:${site.id}`,
      payload: { siteId: site.id },
      action: async () => {
        await client.setWorkersDev(
          site.providerConfig.accountId,
          site.providerConfig.workerName,
          true
        )
        const domains = (await listSiteResources(site.id)).filter(
          (row) =>
            row.kind === "custom-domain" &&
            row.status === "orphaned" &&
            row.displayName &&
            row.metadata?.zoneId
        )
        for (const domain of domains) {
          const attached = await client.attachDomain(site.providerConfig.accountId, {
            zoneId: domain.metadata!.zoneId,
            hostname: domain.displayName!,
            workerName: site.providerConfig.workerName,
          })
          await setSiteResourceStatus(domain.id, "deleted", this.deps.now())
          await recordSiteResource({
            id: resourceId(site.id, "custom-domain", attached.id),
            siteId: site.id,
            provider: "cloudflare",
            kind: "custom-domain",
            providerResourceId: attached.id,
            displayName: domain.displayName!,
            metadata: { zoneId: domain.metadata!.zoneId },
            ownership: "managed",
            dependencies: [resourceId(site.id, "worker", site.providerConfig.workerName)],
            now: this.deps.now(),
          })
        }
        await setSiteLifecycle(site.id, "active", this.deps.now())
      },
    })
  }

  private async deleteManagedResource(
    site: SiteProjectRow,
    client: CloudflareClient,
    resource: SiteResourceRow
  ): Promise<void> {
    const accountId = site.providerConfig.accountId
    switch (resource.kind) {
      case "custom-domain":
        await client.detachDomain(accountId, resource.providerResourceId)
        break
      case "access-policy": {
        const appId = resource.dependencies[0]
          ? (await getSiteResource(resource.dependencies[0]))?.providerResourceId
          : undefined
        if (appId) await client.deleteAccessPolicy(accountId, appId, resource.providerResourceId)
        break
      }
      case "access-application":
        await client.deleteAccessApplication(accountId, resource.providerResourceId)
        break
      case "secret":
        await client.bulkUpdateSecrets(accountId, site.providerConfig.workerName, {
          [resource.providerResourceId]: null,
        })
        break
      case "worker-version":
        await client.deleteVersion(
          accountId,
          site.providerConfig.workerName,
          resource.providerResourceId
        )
        break
      case "worker":
        await client.deleteWorker(accountId, site.providerConfig.workerName)
        break
      case "d1-database":
        await client.deleteD1Database(accountId, resource.providerResourceId)
        break
      case "r2-bucket":
        await client.deleteR2Bucket(accountId, resource.providerResourceId)
        break
    }
  }

  private async purgeManagedResources(
    site: SiteProjectRow,
    client: CloudflareClient
  ): Promise<void> {
    const resources = await listSiteResources(site.id)
    for (const resource of resources.filter(
      (row) => row.ownership !== "managed" && row.status !== "deleted"
    )) {
      // The provider object remains intact. `orphaned` preserves that fact in
      // the purge report until the user separately deletes Cognia metadata.
      await setSiteResourceStatus(resource.id, "orphaned", this.deps.now())
    }

    let remaining = (await listSiteResources(site.id)).filter(
      (row) => row.ownership === "managed" && row.status !== "deleted"
    )
    while (remaining.length > 0) {
      const purgeable: SiteResourceRow[] = []
      for (const resource of remaining) {
        if (await siteResourceCanBePurged(resource.id)) purgeable.push(resource)
      }
      if (purgeable.length === 0) {
        throw new Error("Site resource dependency graph cannot be purged")
      }
      for (const resource of purgeable) {
        await setSiteResourceStatus(resource.id, "deleting", this.deps.now())
        await this.deleteManagedResource(site, client, resource)
        await setSiteResourceStatus(resource.id, "deleted", this.deps.now())
      }
      remaining = (await listSiteResources(site.id)).filter(
        (row) => row.ownership === "managed" && row.status !== "deleted"
      )
    }
  }

  async purge(siteId: string): Promise<void> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "manage")
    if (site.lifecycle !== "taken-down") throw new Error("Site must be taken down before purge")
    const attempt = (await listSiteOperations(site.id)).filter(
      (operation) => operation.type === "purge"
    ).length
    await setSiteLifecycle(site.id, "deleting", this.deps.now())
    try {
      await this.runOperation({
        site: { ...site, lifecycle: "deleting" },
        type: "purge",
        idempotencyKey: `purge:${site.id}:${attempt}`,
        payload: { siteId: site.id, attempt },
        action: async () => {
          await this.purgeManagedResources(site, client)
          await setSiteLifecycle(site.id, "deleted", this.deps.now())
        },
      })
    } catch (error) {
      if (!mutationOutcomeIsUncertain(error)) {
        const current = await getSiteProject(site.id)
        if (current?.lifecycle === "deleting") {
          await setSiteLifecycle(site.id, "taken-down", this.deps.now())
        }
      }
      throw error
    }
  }

  /**
   * Resolve every operation waiting on an uncertain provider outcome.
   *
   * Wrapped in an operation of its own. `SiteOperationType` has always carried
   * `"reconcile"` and nothing ever queued one, so reconciliation did real
   * provider round-trips that left no durable trace: a crash mid-reconcile was
   * invisible, and the result was only visible if you happened to be on the
   * operations tab. Now it appears in the journal, feeds recovery, and
   * notifies like everything else.
   *
   * The idempotency key carries a nonce on purpose. `queueSiteOperation`
   * returns the existing row for a repeated key and `runOperation` then throws
   * "already succeeded" — a fixed key would make reconciliation a thing you can
   * do exactly once per Site, forever.
   */
  async reconcile(siteId: string): Promise<{ resolved: number; remaining: number }> {
    const { site } = await this.client(siteId, true)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "manage")
    return this.runOperation({
      site,
      type: "reconcile",
      idempotencyKey: `reconcile:${site.id}:${this.deps.newId("run")}`,
      payload: { siteId: site.id },
      action: () => this.reconcileWaiting(siteId),
    })
  }

  private async reconcileWaiting(siteId: string): Promise<{ resolved: number; remaining: number }> {
    const { site, client } = await this.client(siteId, true)
    const waiting = (await listSiteOperations(site.id)).filter(
      (operation) => operation.status === "waiting-reconcile"
    )
    let resolved = 0
    for (const operation of waiting) {
      const payload =
        operation.inputPayload && typeof operation.inputPayload === "object"
          ? (operation.inputPayload as Record<string, unknown>)
          : {}
      try {
        if (operation.type === "provision") {
          const kind = payload.kind
          const name = typeof payload.resourceName === "string" ? payload.resourceName : ""
          const bindingName = typeof payload.name === "string" ? payload.name : ""
          const ownership = payload.ownership
          if (
            (kind !== "d1" && kind !== "r2") ||
            !name ||
            !bindingName ||
            !["managed", "adopted", "shared"].includes(String(ownership))
          ) {
            throw new Error("Site provision reconciliation payload is invalid")
          }
          const match =
            kind === "d1"
              ? (await client.listD1Databases(site.providerConfig.accountId)).find(
                  (row) => row.name === name && row.uuid
                )
              : (await client.listR2Buckets(site.providerConfig.accountId)).find(
                  (row) => row.name === name
                )
          const providerId =
            kind === "d1"
              ? (match as { uuid?: string } | undefined)?.uuid
              : (match as { name?: string } | undefined)?.name
          if (!providerId) throw new Error("Cloudflare binding has not converged")
          await recordSiteResource({
            id: resourceId(site.id, kind === "d1" ? "d1-database" : "r2-bucket", providerId),
            siteId: site.id,
            provider: "cloudflare",
            kind: kind === "d1" ? "d1-database" : "r2-bucket",
            providerResourceId: providerId,
            displayName: name,
            metadata: { bindingName },
            ownership: ownership as SiteResourceRow["ownership"],
            dependencies: [],
            now: this.deps.now(),
          })
        } else if (operation.type === "upload") {
          const versionId = typeof payload.versionId === "string" ? payload.versionId : ""
          const version = await getSiteVersion(versionId)
          if (!version || version.siteId !== site.id || !version.artifactDigest) {
            throw new Error("Site upload reconciliation version is invalid")
          }
          const providerId = versionProviderId(
            await client.listVersions(
              site.providerConfig.accountId,
              site.providerConfig.workerName
            ),
            `cognia-${version.id}`
          )
          if (!providerId) throw new Error("Cloudflare version has not converged")
          const bindingIds = (await listSiteResources(site.id))
            .filter((row) => ["d1-database", "r2-bucket"].includes(row.kind))
            .map((row) => row.id)
          const worker = await recordSiteResource({
            id: resourceId(site.id, "worker", site.providerConfig.workerName),
            siteId: site.id,
            provider: "cloudflare",
            kind: "worker",
            providerResourceId: site.providerConfig.workerName,
            displayName: site.providerConfig.workerName,
            ownership: "managed",
            dependencies: bindingIds,
            now: this.deps.now(),
          })
          await recordSiteResource({
            id: resourceId(site.id, "worker-version", providerId),
            siteId: site.id,
            provider: "cloudflare",
            kind: "worker-version",
            providerResourceId: providerId,
            displayName: version.id,
            metadata: { artifactDigest: version.artifactDigest },
            ownership: "managed",
            dependencies: [worker.id, ...bindingIds],
            now: this.deps.now(),
          })
        } else if (operation.type === "deploy") {
          const deploymentId = typeof payload.deploymentId === "string" ? payload.deploymentId : ""
          const providerVersionId =
            typeof payload.providerVersionId === "string" ? payload.providerVersionId : ""
          const local = await getSiteDeployment(deploymentId)
          const provider = (
            await client.listDeployments(
              site.providerConfig.accountId,
              site.providerConfig.workerName
            )
          ).find((candidate) => {
            if (!candidate || typeof candidate !== "object") return false
            const versions = (candidate as { versions?: Array<{ version_id?: string }> }).versions
            return versions?.some((version) => version.version_id === providerVersionId)
          }) as { id?: string } | undefined
          if (!local || !provider?.id) throw new Error("Cloudflare deployment has not converged")
          const subdomain = await client.getWorkersSubdomain(site.providerConfig.accountId)
          await markSiteDeploymentActive({
            deploymentId: local.id,
            providerDeploymentId: provider.id,
            productionUrl: `https://${site.providerConfig.workerName}.${subdomain.subdomain}.workers.dev`,
            now: this.deps.now(),
          })
        } else if (operation.type === "domain") {
          const providerDomains = await client.listDomains(site.providerConfig.accountId)
          if (typeof payload.hostname === "string") {
            const match = providerDomains.find(
              (candidate) =>
                !!candidate &&
                typeof candidate === "object" &&
                (candidate as { hostname?: string }).hostname === payload.hostname
            ) as { id?: string } | undefined
            if (!match?.id) throw new Error("Cloudflare custom domain has not converged")
            await recordSiteResource({
              id: resourceId(site.id, "custom-domain", match.id),
              siteId: site.id,
              provider: "cloudflare",
              kind: "custom-domain",
              providerResourceId: match.id,
              displayName: payload.hostname,
              metadata: { zoneId: String(payload.zoneId ?? site.providerConfig.zoneId ?? "") },
              ownership: "managed",
              dependencies: [resourceId(site.id, "worker", site.providerConfig.workerName)],
              now: this.deps.now(),
            })
          } else if (typeof payload.resourceId === "string") {
            const resource = await getSiteResource(payload.resourceId)
            if (!resource) throw new Error("Site domain resource not found")
            const stillPresent = providerDomains.some(
              (candidate) =>
                !!candidate &&
                typeof candidate === "object" &&
                (candidate as { id?: string }).id === resource.providerResourceId
            )
            if (stillPresent) throw new Error("Cloudflare custom domain removal has not converged")
            await setSiteResourceStatus(resource.id, "deleted", this.deps.now())
          }
        } else if (operation.type === "access") {
          const policy = payload.policy as SiteVisitorPolicy | undefined
          const hostname = typeof payload.hostname === "string" ? payload.hostname : ""
          if (!policy) throw new Error("Site access reconciliation payload is invalid")
          const desired = compileCloudflareAccessPolicy(policy)
          const applications = await client.listAccessApplications(site.providerConfig.accountId)
          const application = applications.find(
            (candidate) =>
              !!candidate &&
              typeof candidate === "object" &&
              (candidate as { domain?: string }).domain === hostname
          ) as { id?: string } | undefined
          if (!desired.applicationRequired) {
            if (application) throw new Error("Cloudflare Access removal has not converged")
          } else {
            if (!application?.id) throw new Error("Cloudflare Access application has not converged")
            const policies = (
              await client.listAccessPolicies(site.providerConfig.accountId, application.id)
            ).map(accessPolicy)
            if (!cloudflareAccessPolicyMatches(desired, policies)) {
              throw new Error("Cloudflare Access policy has not converged")
            }
          }
          await updateSiteVisitorPolicy(site.id, policy, this.deps.now())
        } else if (operation.type === "takedown") {
          await client.setWorkersDev(
            site.providerConfig.accountId,
            site.providerConfig.workerName,
            false
          )
          const providerDomains = await client.listDomains(site.providerConfig.accountId)
          for (const resource of (await listSiteResources(site.id)).filter(
            (row) => row.kind === "custom-domain" && row.status === "active"
          )) {
            const present = providerDomains.some(
              (candidate) =>
                !!candidate &&
                typeof candidate === "object" &&
                (candidate as { id?: string }).id === resource.providerResourceId
            )
            if (present) {
              await client.detachDomain(site.providerConfig.accountId, resource.providerResourceId)
            }
            await setSiteResourceStatus(resource.id, "orphaned", this.deps.now())
          }
          await markSiteDeploymentsTakenDown(site.id, this.deps.now())
          const current = await getSiteProject(site.id)
          if (current?.lifecycle === "active") {
            await setSiteLifecycle(site.id, "taken-down", this.deps.now())
          }
        } else if (operation.type === "restore") {
          await client.setWorkersDev(
            site.providerConfig.accountId,
            site.providerConfig.workerName,
            true
          )
          const domains = (await listSiteResources(site.id)).filter(
            (row) =>
              row.kind === "custom-domain" &&
              row.status === "orphaned" &&
              row.displayName &&
              row.metadata?.zoneId
          )
          for (const domain of domains) {
            const attached = await client.attachDomain(site.providerConfig.accountId, {
              zoneId: domain.metadata!.zoneId,
              hostname: domain.displayName!,
              workerName: site.providerConfig.workerName,
            })
            await setSiteResourceStatus(domain.id, "deleted", this.deps.now())
            await recordSiteResource({
              id: resourceId(site.id, "custom-domain", attached.id),
              siteId: site.id,
              provider: "cloudflare",
              kind: "custom-domain",
              providerResourceId: attached.id,
              displayName: domain.displayName!,
              metadata: { zoneId: domain.metadata!.zoneId },
              ownership: "managed",
              dependencies: [resourceId(site.id, "worker", site.providerConfig.workerName)],
              now: this.deps.now(),
            })
          }
          await setSiteLifecycle(site.id, "active", this.deps.now())
        } else if (operation.type === "purge") {
          await this.purgeManagedResources(site, client)
          const current = await getSiteProject(site.id)
          if (current?.lifecycle === "deleting") {
            await setSiteLifecycle(site.id, "deleted", this.deps.now())
          }
        } else {
          throw new Error(`Site operation type cannot be reconciled: ${operation.type}`)
        }
        await resolveSiteOperationFromReconcile({
          operationId: operation.id,
          message: "Provider state reconciled by Cognia Sites",
          now: this.deps.now(),
        })
        resolved += 1
      } catch {
        // Leave the operation waiting. The caller receives the remaining
        // count and can retry after provider state converges.
      }
    }
    return { resolved, remaining: waiting.length - resolved }
  }
}
