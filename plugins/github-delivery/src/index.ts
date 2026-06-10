/**
 * GitHub Delivery — built-in plugin entry point.
 *
 * `activate()` wires the plugin's runtime services:
 *   1. Touches the 4 declared Dexie tables (repos / workOrders / events / audit)
 *      to surface mis-declared schemas at activation time.
 *   2. Imports `./workflow/nodes` for its side-effect of registering all 12
 *      `action.github.*` node executors against the workflow registry.
 *   3. Calls `setGithubRuntime(...)` with real implementations of `getRepo`,
 *      `getOctokit`, `recordAudit`, and `checkPolicy` so those node executors
 *      can resolve credentials, persist audit rows, and gate actions.
 *
 * `deactivate()` clears the singleton and resets internal state. The plugin
 * manager re-runs `activate()` on the next enable so this is safe.
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import { getOctokitForRepo } from "@/lib/github/octokit-factory"
import { checkPolicy as runPolicyGate, mergePolicy } from "@/lib/github/policy-gate"
import {
  DEFAULT_GH_POLICY,
  type GhAuditEntry,
  type GhAction,
  type GhPolicy,
  type GhRepoEntry,
  type GhWorkOrder,
  type NormalizedGhEvent,
  type WorkOrderStatus,
} from "@/lib/github/types"
import { requireGithubRuntime, setGithubRuntime, type GithubRuntime } from "./workflow/runtime"
import { ghEventToInbound } from "./connector/inbox-bridge"
import { runGithubPoll, type GhTable } from "./github-poll"
import { setIssueLoopDriver } from "./workflow/issue-loop"
import { SidecarIssueLoopDriver } from "./drivers/sidecar-driver"
import { GithubAdapter } from "./adapter/github-adapter"
import type { PluginAdapterContext } from "@/lib/plugin/bridge/connectors-bridge"
// Post-ADR-0026 migration: nodes are no longer registered via top-level
// side effects. The module collects descriptors at load time; we call
// `registerGithubNodes()` in activate / `unregisterGithubNodes()` in
// deactivate so the kinds disappear cleanly when the plugin is disabled.
import { registerGithubNodes, unregisterGithubNodes } from "./workflow/nodes"

interface ActivationState {
  activatedAt: number
  ctx: PluginContext
}

let state: ActivationState | null = null

// ── Runtime implementation backed by the plugin context ──────────────────────

async function lookupRepo(ctx: PluginContext, fullName: string): Promise<GhRepoEntry | null> {
  if (!ctx.dexie) return null
  const table = ctx.dexie.table<GhRepoEntry, string>("repos")
  return (await table.get(fullName)) ?? null
}

async function buildOctokit(ctx: PluginContext, fullName: string) {
  const repo = await lookupRepo(ctx, fullName)
  if (!repo) {
    throw new Error(`github-delivery: repo "${fullName}" is not registered`)
  }
  if (repo.credentialMode === "pat") {
    // Prefer keyring slot when present; fall back to the row's patToken.
    const token =
      (repo.patKeyringId && (await ctx.secrets?.get?.(repo.patKeyringId))) ?? repo.patToken
    if (!token) {
      throw new Error(`github-delivery: PAT for "${fullName}" not found`)
    }
    return getOctokitForRepo({
      repoFullName: fullName,
      mode: "pat",
      pat: { token },
      onWarning: (m) => ctx.logger?.warn?.(`[github-delivery] ${m}`),
    })
  }
  // App mode — appId + privateKey live on the row; installationId is required.
  if (!repo.installationId) {
    throw new Error(`github-delivery: repo "${fullName}" missing installationId`)
  }
  const appId =
    repo.appId ?? parseInt((await ctx.secrets?.get?.("github-delivery:appId")) ?? "0", 10)
  const privateKey =
    repo.appPrivateKey ?? (await ctx.secrets?.get?.("github-delivery:privateKey")) ?? ""
  if (!appId || !privateKey) {
    throw new Error(`github-delivery: App credentials missing for "${fullName}"`)
  }
  return getOctokitForRepo({
    repoFullName: fullName,
    mode: "app",
    app: { appId, privateKey, installationId: repo.installationId },
    onWarning: (m) => ctx.logger?.warn?.(`[github-delivery] ${m}`),
  })
}

async function persistAudit(ctx: PluginContext, row: GhAuditEntry): Promise<void> {
  if (!ctx.dexie) return
  const table = ctx.dexie.table<GhAuditEntry, number>("audit")
  await table.put(row)
  // Cap at 5000 newest — same convention as connectorAudit.
  const count = await table.toCollection().count()
  if (count > 5000) {
    const overflow = count - 5000
    const oldest = await table.orderBy("at").limit(overflow).primaryKeys()
    if (oldest.length > 0) {
      await table.bulkDelete(oldest as number[])
    }
  }
}

async function evaluatePolicy(
  ctx: PluginContext,
  action: GhAction,
  override?: Partial<GhPolicy>
): Promise<{ decision: ReturnType<typeof runPolicyGate>; effectivePolicy: GhPolicy }> {
  // Resolve the repo from the action (every GhAction shape carries a repo).
  const repoFullName = repoOfAction(action)
  const repo = repoFullName ? await lookupRepo(ctx, repoFullName) : null
  const base = repo?.policy ?? DEFAULT_GH_POLICY
  const effectivePolicy = mergePolicy(base, override)

  // Count today's merges from the audit table for the maxDailyMerges check.
  const today = startOfUtcDay(Date.now())
  let mergesToday = 0
  if (ctx.dexie && repoFullName) {
    const auditTable = ctx.dexie.table<GhAuditEntry, number>("audit")
    const rows = await auditTable
      .where("[repoFullName+at]")
      .between([repoFullName, today], [repoFullName, Number.MAX_SAFE_INTEGER])
      .toArray()
    mergesToday = rows.filter((r) => r.action.kind === "merge" && r.decision.allow === true).length
  }

  const decision = runPolicyGate(action, {
    policy: effectivePolicy,
    now: Date.now(),
    mergesTodayCount: mergesToday,
    // Author / CI / approval signals come from the node inspector form or the
    // upstream trigger payload. The current minimal wiring leaves them empty;
    // the node author can override per-node via `policyOverride`.
  })
  return { decision, effectivePolicy }
}

function repoOfAction(action: GhAction): string | null {
  switch (action.kind) {
    case "push":
    case "release":
      return action.repo
    case "merge":
      return action.pr.repo
    case "label":
    case "close":
      return action.target.repo
    case "comment":
      return action.pr?.repo ?? action.issue?.repo ?? null
  }
}

function startOfUtcDay(ms: number): number {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

async function getWorkOrder(
  ctx: PluginContext,
  repoFullName: string,
  issueNumber: number
): Promise<GhWorkOrder | null> {
  if (!ctx.dexie) return null
  const table = ctx.dexie.table<GhWorkOrder, number>("workOrders")
  // Compound index [status+repoFullName] is declared; for lookups by repo+issue
  // we scan the small per-repo slice (workOrders grow slowly).
  const rows = await table.where("issueNumber").equals(issueNumber).toArray()
  return rows.find((r) => r.repoFullName === repoFullName) ?? null
}

async function upsertWorkOrder(
  ctx: PluginContext,
  patch: Partial<GhWorkOrder> & {
    repoFullName: string
    issueNumber: number
    status: WorkOrderStatus
  }
): Promise<GhWorkOrder> {
  if (!ctx.dexie) {
    // Shouldn't happen — runtime only gets installed when dexie is present.
    throw new Error("upsertWorkOrder: ctx.dexie unavailable")
  }
  const table = ctx.dexie.table<GhWorkOrder, number>("workOrders")
  const existing = await getWorkOrder(ctx, patch.repoFullName, patch.issueNumber)
  const now = Date.now()
  const merged: GhWorkOrder = existing
    ? { ...existing, ...patch, updatedAt: now }
    : { ...patch, createdAt: now, updatedAt: now }
  const id = await table.put(merged)
  return { ...merged, id: typeof id === "number" ? id : merged.id }
}

function makeRuntime(ctx: PluginContext): GithubRuntime {
  return {
    getRepo: (fullName) => lookupRepo(ctx, fullName),
    getOctokit: (fullName) => buildOctokit(ctx, fullName),
    recordAudit: (row) => persistAudit(ctx, row),
    checkPolicy: (action, override) => evaluatePolicy(ctx, action, override),
    getWorkOrder: (fullName, n) => getWorkOrder(ctx, fullName, n),
    upsertWorkOrder: (patch) => upsertWorkOrder(ctx, patch),
  }
}

// ── Plugin definition ─────────────────────────────────────────────────────────

const definition: PluginDefinition = {
  manifest: {
    id: "github-delivery",
    name: "GitHub Delivery",
    version: "1.0.0",
    type: "frontend",
    capabilities: ["tools", "components", "providers", "exporters", "connectors"],
    main: "src/index.ts",
  } as never,
  activate: async (ctx?: PluginContext) => {
    if (!ctx) throw new Error("github-delivery: ctx is required")
    if (!ctx.dexie) {
      throw new Error("github-delivery requires the platform Dexie API (manifest.dexie missing?)")
    }

    // Touch each declared table.
    await Promise.all([
      ctx.dexie.table<GhRepoEntry>("repos").toCollection().count(),
      ctx.dexie.table<GhWorkOrder>("workOrders").toCollection().count(),
      ctx.dexie.table<NormalizedGhEvent>("events").toCollection().count(),
      ctx.dexie.table<GhAuditEntry>("audit").toCollection().count(),
    ])

    setGithubRuntime(makeRuntime(ctx))
    // Real driver for `action.github.runIssueLoop` — uses the existing
    // Claude sidecar (+ its built-in cognia-tools MCP) to drive the agent
    // SDK inside the cloned workspace. Without this, the executor returns
    // the friendly "No issue-loop AI driver" failure result.
    setIssueLoopDriver(new SidecarIssueLoopDriver())
    // Register the 13 action.github.* executors against the workflow
    // registry. Pre-ADR-0026 this happened at import-time; the new path
    // lets us tear down cleanly in `deactivate()` so disabling the
    // plugin actually removes the kinds from the editor.
    const registered = registerGithubNodes()
    state = { activatedAt: Date.now(), ctx }
    ctx.logger?.info(`github-delivery: activated (registered ${registered} workflow nodes)`)
  },
  deactivate: async (ctx?: PluginContext) => {
    unregisterGithubNodes()
    setIssueLoopDriver(null)
    setGithubRuntime(null)
    state = null
    ctx?.logger?.info("github-delivery: deactivated")
  },
}

export default definition

/** Test-only — peek at activation state without touching internals. */
export function _peekState(): ActivationState | null {
  return state
}

/**
 * Plugin connector bridge factory — referenced by `plugin.json:connectors[]`.
 * The bridge calls this with `{ pluginId, connectorDef }`; we build a
 * GithubAdapter whose `getOctokit` delegates to the GithubRuntime singleton
 * (installed by `activate`). Exporting from the main entrypoint is how
 * `registerPluginAdapters` discovers the function — see
 * `lib/plugin/connectors-bridge.ts`.
 */
export function createGithubAdapterForBridge(ctx: PluginAdapterContext): GithubAdapter {
  return new GithubAdapter(`${ctx.pluginId}/${ctx.connectorDef.type}`, {
    getOctokit: (fullName) => requireGithubRuntime().getOctokit(fullName),
  })
}

/**
 * One-shot polling pass over all registered repos. Exported so the
 * scheduler can invoke it on its own cadence, and tests can drive it
 * directly.
 *
 * For each new event the bridge produces an InboundEvent and (when a
 * ConnectorBus is available) dispatches it. The function never throws —
 * per-repo failures are captured by runGithubPoll and surfaced in the
 * returned result list.
 */
export async function runPluginPoll(
  ctx: PluginContext,
  busInbound?: (event: import("@/types/connectors/event").NormalizedInboundEvent) => Promise<void>
) {
  if (!ctx.dexie) return []
  const reposTable = ctx.dexie.table<GhRepoEntry, string>("repos") as unknown as GhTable<
    GhRepoEntry,
    string
  >
  const eventsTable = ctx.dexie.table<NormalizedGhEvent, string>("events") as unknown as GhTable<
    NormalizedGhEvent,
    string
  >
  return runGithubPoll({
    reposTable,
    eventsTable,
    octokitFor: (repo) => buildOctokit(ctx, repo.fullName),
    onEvent: busInbound
      ? async (event) => {
          const inbound = ghEventToInbound(event)
          if (inbound) await busInbound(inbound)
        }
      : undefined,
    logger: ctx.logger,
  })
}
