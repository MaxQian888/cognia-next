/**
 * Cognia Sites workflow actions (ADR-0084):
 * `action.site.{build,deploy,rollback,status}`.
 *
 * Four kinds, deliberately. `upload` is folded into `deploy` — `deployVersion`
 * refuses an un-uploaded version anyway, so two nodes would make the author
 * responsible for an ordering the service already enforces, and a flow that
 * stops between them leaves a Site half-published. `takedown` and `purge` are
 * console-only: taking a live site off the internet, or deleting managed
 * provider resources, are not things an unattended DAG should reach.
 * `reconcile`'s entire output is meant for a human to read.
 *
 * `action.site.status` is what makes the family worth having — it is what a
 * `flow.if` branches on for "deploy, verify, roll back".
 *
 * Three rules every privileged executor here follows:
 *
 *  - **Refuse off the desktop first**, before reading a param, the way
 *    `lib/workflow/nodes/automation/web-clone.ts` does. Builds need the OS
 *    sandbox and uploads shell out to wrangler.
 *  - **Read the actor from the account store, never from a param.** A workflow
 *    author who could type an account id would make
 *    `assertSiteAuthoringCapability` pass for whatever they typed, and the
 *    authoring policy would stop being a policy.
 *  - **`retryable: false`.** A retry re-queues under the same idempotency key;
 *    `queueSiteOperation` returns the existing row and `runOperation` then
 *    throws "requires reconciliation". An automatic retry can never succeed —
 *    it only burns the run budget and buries the real error.
 */

import {
  getSiteProject,
  listSiteDeployments,
  listSiteEnvironmentRevisions,
  listSiteOperations,
  listSiteVersions,
} from "@/lib/db/sites"
import { isTauri } from "@/lib/tauri"
import { buildAndSaveSiteVersion } from "@/lib/sites/build-version"
import { SITE_BUILD_INPUT_DEFAULTS } from "@/lib/sites/build-inputs"
import {
  collectSiteFailures,
  currentVersion,
  latestEnvironmentRevision,
  pickActiveDeployment,
  siteProductionUrl,
} from "@/lib/sites/console-model"
import { publishSiteVersion } from "@/lib/sites/publish-version"
import { CloudflareSitesService } from "@/lib/sites/cloudflare/service"
import { useAccountStore } from "@/stores/account/account-store"
import { registerNodeExecutor } from "../registry"
import type { StepExecutionContext } from "@/types/workflow/visual"
import type { SiteDeploymentRow, SiteVersionRow } from "@/types/sites"

/** Ten minutes past the service's own build lease, so the node never wins. */
const BUILD_TIMEOUT_MS = 70 * 60_000
const DEPLOY_TIMEOUT_MS = 30 * 60_000

function requireDesktop(kind: string): void {
  if (!isTauri()) throw new Error(`${kind}: publishing a Cognia Site needs the desktop app`)
}

/**
 * The actor every authoring assertion is made against.
 *
 * Fails closed rather than defaulting: an unlocked vault is what makes the
 * keyring reachable, and a Site's authoring policy names real accounts.
 */
function requireActor(kind: string): string {
  const actorAccountId = useAccountStore.getState().unlockedAccountId
  if (!actorAccountId) throw new Error(`${kind}: unlock your account before publishing a Site`)
  return actorAccountId
}

function requireSiteId(ctx: StepExecutionContext, kind: string): string {
  const siteId = typeof ctx.params.siteId === "string" ? ctx.params.siteId.trim() : ""
  if (!siteId) throw new Error(`${kind}: siteId is required`)
  return siteId
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === "string" && item.length > 0)
}

/** The wire shape of a version, flattened for `{{ $node[...] }}` consumers. */
function toWorkflowVersion(version: SiteVersionRow) {
  return {
    id: version.id,
    sequence: version.sequence,
    status: version.status,
    commitSha: version.source.commitSha,
    dirty: version.source.dirty,
    artifactDigest: version.artifactDigest ?? null,
    failureMessage: version.failureMessage ?? null,
  }
}

function toWorkflowDeployment(deployment: SiteDeploymentRow | undefined) {
  return deployment
    ? {
        id: deployment.id,
        versionId: deployment.versionId,
        status: deployment.status,
        productionUrl: deployment.productionUrl ?? null,
        updatedAt: deployment.updatedAt,
      }
    : null
}

registerNodeExecutor({
  kind: "action.site.build",
  typeVersion: 1,
  retryable: false,
  timeoutMs: BUILD_TIMEOUT_MS,
  execute: async (ctx) => {
    requireDesktop("action.site.build")
    const actorAccountId = requireActor("action.site.build")
    const siteId = requireSiteId(ctx, "action.site.build")
    const environment = latestEnvironmentRevision(await listSiteEnvironmentRevisions(siteId))
    if (!environment) {
      throw new Error("action.site.build: save an environment revision for this Site first")
    }
    const version = await buildAndSaveSiteVersion({
      siteId,
      environmentRevisionId: environment.id,
      runtime:
        typeof ctx.params.runtime === "string"
          ? ctx.params.runtime
          : SITE_BUILD_INPUT_DEFAULTS.runtime,
      packageManager:
        typeof ctx.params.packageManager === "string"
          ? ctx.params.packageManager
          : SITE_BUILD_INPUT_DEFAULTS.packageManager,
      installNetworkHosts:
        stringList(ctx.params.installNetworkHosts) ?? SITE_BUILD_INPUT_DEFAULTS.installNetworkHosts,
      // Never inherits a default: an unattended build reaching the network is a
      // decision, and ADR-0084's fail-closed rule is the whole point.
      buildNetworkHosts: stringList(ctx.params.buildNetworkHosts) ?? [],
      actorAccountId,
    })
    return { output: toWorkflowVersion(version) }
  },
})

registerNodeExecutor({
  kind: "action.site.deploy",
  typeVersion: 1,
  retryable: false,
  timeoutMs: DEPLOY_TIMEOUT_MS,
  execute: async (ctx) => {
    requireDesktop("action.site.deploy")
    const actorAccountId = requireActor("action.site.deploy")
    const siteId = requireSiteId(ctx, "action.site.deploy")
    const versions = await listSiteVersions(siteId)
    const named =
      typeof ctx.params.versionId === "string" && ctx.params.versionId
        ? versions.find((version) => version.id === ctx.params.versionId)
        : // Newest ready version, which is what "publish this Site" means when
          // the flow just built one.
          versions.filter((version) => version.status === "ready")[0]
    if (!named) throw new Error("action.site.deploy: no ready version to publish")
    const deployment = await publishSiteVersion({ siteId, versionId: named.id, actorAccountId })
    return {
      output: {
        version: toWorkflowVersion(named),
        deployment: toWorkflowDeployment(deployment),
        productionUrl: deployment.productionUrl ?? null,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.site.rollback",
  typeVersion: 1,
  retryable: false,
  timeoutMs: DEPLOY_TIMEOUT_MS,
  execute: async (ctx) => {
    requireDesktop("action.site.rollback")
    const actorAccountId = requireActor("action.site.rollback")
    const siteId = requireSiteId(ctx, "action.site.rollback")
    const deployments = await listSiteDeployments(siteId)
    const active = pickActiveDeployment(deployments)
    // The newest deployment of a *different* version that once served traffic.
    // Redeploying the same version is not a rollback.
    const previous = [...deployments]
      .filter(
        (row) =>
          row.versionId !== active?.versionId &&
          (row.status === "superseded" || row.status === "taken-down")
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)[0]
    if (!previous) throw new Error("action.site.rollback: this Site has no earlier version live")
    // Already uploaded, so this is a deploy of an existing worker version
    // rather than a republish.
    const deployment = await new CloudflareSitesService({ actorAccountId }).deployVersion(
      siteId,
      previous.versionId
    )
    return {
      output: {
        rolledBackTo: previous.versionId,
        deployment: toWorkflowDeployment(deployment as SiteDeploymentRow),
      },
    }
  },
})

// No `requireDesktop`: a Dexie read that must answer in every shell, so a flow
// can report what happened even where it could not have acted.
registerNodeExecutor({
  kind: "action.site.status",
  typeVersion: 1,
  retryable: true,
  execute: async (ctx) => {
    const siteId = requireSiteId(ctx, "action.site.status")
    const site = await getSiteProject(siteId)
    if (!site) throw new Error("action.site.status: Site not found")
    const [versions, deployments, operations] = await Promise.all([
      listSiteVersions(siteId),
      listSiteDeployments(siteId),
      listSiteOperations(siteId),
    ])
    const live = currentVersion(versions, deployments)
    const failures = collectSiteFailures(versions, deployments, operations)
    return {
      output: {
        id: site.id,
        name: site.name,
        lifecycle: site.lifecycle,
        productionUrl: siteProductionUrl(deployments) ?? null,
        currentVersion: live ? toWorkflowVersion(live) : null,
        readyVersions: versions.filter((version) => version.status === "ready").length,
        running: operations.some(
          (operation) => operation.status === "queued" || operation.status === "running"
        ),
        failures: failures.map((failure) => ({
          scope: failure.scope,
          label: failure.label,
          message: failure.message,
        })),
      },
    }
  },
})
