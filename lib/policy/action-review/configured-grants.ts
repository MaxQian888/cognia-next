/**
 * The recipient lists a person configured: the `policy` grants (ADR-0239).
 *
 * Three lists exist, and only a person writes any of them:
 *
 * - A connector instance's `outboundRecipients` (`adapter:<id>`): any delivery
 *   through that bot account, whoever makes it, may reach these recipients
 *   with nobody watching. Looked up for every plan, from the targets' channel.
 * - A conversation's `proactivePush` opt-in (`proactive-push:<key>`), set in
 *   the conversation's override form: the conversation itself.
 * - A Bot installation's `outboundRecipients` (`bot:<id>`): only that Bot's
 *   runs. An agent-turn Bot passes it with its turn ({@link botRecipientGrants});
 *   a handler Bot's own plugin code is covered while its run is live
 *   ({@link beginBotOutboundRun}). It may hold repositories.
 *
 * GitHub writes (ADR-0239 phase 2) have four more, each a repository grant a
 * person already wrote somewhere else, or wrote for this:
 *
 * - An integration account's `outboundRecipients` (`integration-account:<id>`):
 *   any unattended write through that account ({@link configuredGithubGrants}).
 * - A CapabilityGrant scoped to repositories that covers the write's operation
 *   (`capability-grant:<id>`), for a broker action through its account.
 * - A Bot installation's repository scope when its writes publish without a
 *   person (`bot-scope:<id>`, {@link botScopeGrants}).
 * - An Agent Team's repository bindings a person consented to publish to when
 *   turning stacked delivery on (`team-delivery:<teamId>`,
 *   {@link teamDeliveryGrants}).
 *
 * Browser submissions (ADR-0239 phase 2b) have one more, besides a Bot
 * installation's list, which may hold sites: the global site list in Settings
 * → Security (`agentPermissions.outboundSites`, `browser-sites`,
 * {@link configuredSiteGrants}), which covers every submission to a listed
 * site, whichever run makes it.
 *
 * A lookup that fails grants nothing: the plan then asks, drafts or parks,
 * never sends on a failure.
 */

import {
  validateOutboundRecipientGrants,
  type OutboundRecipientGrant,
} from "@cognia/agent-config-types/action-review"
import type { CapabilityGrant, ServiceConnection } from "@/types/external-service"
import type { IntegrationActionRisk } from "@/types/plugin/plugin-integration"
import type { AgentTeamGithubDeliveryPolicy } from "@/types/agent/agent-team-runtime"
import { consentedRepositoryPaths } from "@/lib/stack/team-policy"

import type { OutboundPolicyGrantList } from "./plan-context"
import { outboundFingerprint, repositoryOnHost, type OutboundTarget } from "./outbound-targets"

export interface ConfiguredGrantDeps {
  /** A connector instance's recipient list. Default: the `adapterInstances` row. */
  adapterRecipients?: (adapterId: string) => Promise<readonly OutboundRecipientGrant[] | undefined>
  /** Whether a conversation opted into proactive pushes. Default: its override row. */
  proactivePush?: (conversationKey: string) => Promise<boolean>
}

/** The fingerprints a configured list grants, under the ref that names the list. */
export function recipientGrantList(
  policyRef: string,
  grants: readonly OutboundRecipientGrant[] | undefined
): OutboundPolicyGrantList | undefined {
  if (!grants || grants.length === 0) return undefined
  return { policyRef, fingerprints: grants.map((grant) => outboundFingerprint(grant.recipient)) }
}

/** A Bot installation's list, for the runs it starts. */
export function botRecipientGrants(installation: {
  id: string
  outboundRecipients?: readonly OutboundRecipientGrant[]
}): OutboundPolicyGrantList[] {
  const list = recipientGrantList(`bot:${installation.id}`, installation.outboundRecipients)
  return list ? [list] : []
}

/**
 * A list entry for a target a person picked, or `undefined` for one no list
 * may hold (a public link, an unnamed recipient). Build the target with
 * `conversationTarget` / `personTarget` / `mailTarget` / `repositoryTarget` /
 * `siteTarget` so the entry is in the engine's normalized form.
 */
export function recipientGrant(
  target: OutboundTarget,
  now: number = Date.now()
): OutboundRecipientGrant | undefined {
  if (target.kind === "public" || target.kind === "unknown") return undefined
  // A repository is listed whole; the thread a write went to is not kept.
  return {
    recipient: { kind: target.kind, channel: target.channel, recipient: target.recipient },
    addedAt: now,
    addedBy: "local-user",
  }
}

/** Whether a list already holds this recipient. */
export function listsRecipient(
  grants: readonly OutboundRecipientGrant[],
  target: Pick<OutboundTarget, "channel" | "recipient">
): boolean {
  return grants.some(
    (grant) =>
      grant.recipient.channel === target.channel && grant.recipient.recipient === target.recipient
  )
}

async function defaultAdapterRecipients(
  adapterId: string
): Promise<readonly OutboundRecipientGrant[] | undefined> {
  const { getAdapterInstance } = await import("@/lib/db/adapter-instances")
  return (await getAdapterInstance(adapterId))?.outboundRecipients
}

async function defaultProactivePush(conversationKey: string): Promise<boolean> {
  const { readForResolution } = await import("@/lib/db/conversation-overrides")
  return (await readForResolution(conversationKey))?.proactivePush === true
}

/** The conversation key a conversation target names, thread dropped. */
function conversationKeyOf(target: OutboundTarget): string | undefined {
  return target.kind === "conversation" ? target.recipient.replace(/^conv:/, "") : undefined
}

/**
 * The lists that could grant these targets: each connector instance they go
 * through, and each conversation's proactive-push opt-in. `conversationKeys`
 * adds keys the caller knows the delivery uses (a thread's key), so an opt-in
 * set on a thread counts for a delivery into that thread.
 */
export async function configuredPolicyGrants(
  targets: readonly OutboundTarget[],
  options: { conversationKeys?: readonly string[] } & ConfiguredGrantDeps = {}
): Promise<OutboundPolicyGrantList[]> {
  const adapterRecipients = options.adapterRecipients ?? defaultAdapterRecipients
  const proactivePush = options.proactivePush ?? defaultProactivePush
  const lists: OutboundPolicyGrantList[] = []

  const channels = new Set(
    targets
      .filter((target) => target.kind === "conversation" || target.kind === "person")
      .map((target) => target.channel)
  )
  for (const adapterId of channels) {
    try {
      const list = recipientGrantList(`adapter:${adapterId}`, await adapterRecipients(adapterId))
      if (list) lists.push(list)
    } catch {
      // Grants nothing; the plan asks instead.
    }
  }

  for (const target of targets) {
    const key = conversationKeyOf(target)
    if (!key) continue
    const keys = new Set([key, ...(options.conversationKeys ?? [])])
    for (const candidate of keys) {
      try {
        if (await proactivePush(candidate)) {
          lists.push({
            policyRef: `proactive-push:${candidate}`,
            fingerprints: [outboundFingerprint(target)],
          })
          break
        }
      } catch {
        // Grants nothing; the plan asks instead.
      }
    }
  }
  return lists
}

// ── GitHub repositories (ADR-0239 phase 2) ─────────────────────────────────

/** What a GitHub write goes through, for the lists that could grant it. */
export interface GithubGrantContext {
  /**
   * The integration account the write goes through. Omitted for a `gh`
   * command, which names no account: every GitHub account's list counts then,
   * since each says a person accepts unattended writes to those repositories.
   */
  account?: { pluginId: string; accountId: string }
  /**
   * The broker action the write runs, for a CapabilityGrant. A raw request
   * and a `gh` command run none, so no CapabilityGrant covers them.
   */
  operation?: {
    actionId: string
    operationId?: string
    risk: IntegrationActionRisk
    workflowId?: string
    sessionId?: string
  }
  /** The account's web host (`githubWebHost`), for a bare `owner/repo`. */
  host?: string
}

/** An account's connection and the CapabilityGrants on it. */
export interface AccountCapabilityGrants {
  connection: Pick<ServiceConnection, "id" | "providerFingerprint">
  grants: readonly CapabilityGrant[]
}

export interface GithubGrantDeps {
  /** An account's list. Default: its `integrationAccounts` row. */
  accountRecipients?: (
    pluginId: string,
    accountId: string
  ) => Promise<readonly OutboundRecipientGrant[] | undefined>
  /** Every GitHub account's list, for a `gh` command. Default: the GitHub rows. */
  githubAccountRecipients?: () => Promise<
    ReadonlyArray<{ id: string; outboundRecipients?: readonly OutboundRecipientGrant[] }>
  >
  /** The CapabilityGrants on an account's connections. Default: the stored ones. */
  capabilityGrants?: (pluginId: string, accountId: string) => Promise<AccountCapabilityGrants[]>
  now?: number
}

async function defaultAccountRecipients(
  pluginId: string,
  accountId: string
): Promise<readonly OutboundRecipientGrant[] | undefined> {
  const { getIntegrationAccount } = await import("@/lib/db/integrations")
  return (await getIntegrationAccount(pluginId, accountId))?.outboundRecipients
}

async function defaultGithubAccountRecipients(): Promise<
  ReadonlyArray<{ id: string; outboundRecipients?: readonly OutboundRecipientGrant[] }>
> {
  const [{ listAllIntegrationAccounts }, { getRegisteredIntegration }, { isGithubIntegration }] =
    await Promise.all([
      import("@/lib/db/integrations"),
      import("@/lib/integrations/registry"),
      import("./github-targets"),
    ])
  return (await listAllIntegrationAccounts()).filter((account) => {
    if (!account.outboundRecipients?.length) return false
    const registered = getRegisteredIntegration(account.pluginId, account.integrationId)
    return registered ? isGithubIntegration(registered.definition) : false
  })
}

async function defaultCapabilityGrants(
  pluginId: string,
  accountId: string
): Promise<AccountCapabilityGrants[]> {
  const { listServiceConnections, listCapabilityGrants } =
    await import("@/lib/db/external-services")
  const connections = (await listServiceConnections({ pluginId })).filter(
    (connection) =>
      connection.providerRef.kind === "integration" &&
      connection.providerRef.accountId === accountId
  )
  return Promise.all(
    connections.map(async (connection) => ({
      connection,
      grants: await listCapabilityGrants(connection.id),
    }))
  )
}

/** The repositories a grant's `repository` scopes name, on `host`. */
function scopedRepositories(grant: CapabilityGrant, host: string | undefined): string[] {
  const fingerprints: string[] = []
  for (const scope of grant.resourceScopes ?? []) {
    if (scope.kind !== "repository") continue
    for (const value of scope.values) {
      const target = repositoryOnHost(value, host)
      if (target) fingerprints.push(outboundFingerprint(target))
    }
  }
  return fingerprints
}

/**
 * The lists that could grant a GitHub write: the account's repository list
 * (or every GitHub account's, for a `gh` command), and each CapabilityGrant
 * on the account that covers the write's operation and is scoped to
 * repositories. A CapabilityGrant with no repository scope covers every
 * repository, which is not a list a person reviewed, so it grants nothing
 * here; the write then asks or waits as before.
 */
export async function configuredGithubGrants(
  context: GithubGrantContext,
  deps: GithubGrantDeps = {}
): Promise<OutboundPolicyGrantList[]> {
  const lists: OutboundPolicyGrantList[] = []
  const account = context.account

  try {
    if (account) {
      const list = recipientGrantList(
        `integration-account:${account.accountId}`,
        await (deps.accountRecipients ?? defaultAccountRecipients)(
          account.pluginId,
          account.accountId
        )
      )
      if (list) lists.push(list)
    } else {
      for (const row of await (deps.githubAccountRecipients ?? defaultGithubAccountRecipients)()) {
        const list = recipientGrantList(`integration-account:${row.id}`, row.outboundRecipients)
        if (list) lists.push(list)
      }
    }
  } catch {
    // Grants nothing; the plan asks instead.
  }

  const operation = context.operation
  if (account && operation && operation.risk !== "read") {
    try {
      const now = new Date(deps.now ?? Date.now()).toISOString()
      const { grantCoversOperation } = await import("@/lib/external-services/grants")
      const capability = {
        capabilityId: operation.actionId,
        ...(operation.operationId ? { operationId: operation.operationId } : {}),
        risk: operation.risk,
      }
      for (const { connection, grants } of await (deps.capabilityGrants ?? defaultCapabilityGrants)(
        account.pluginId,
        account.accountId
      )) {
        for (const grant of grants) {
          const covered = grantCoversOperation(grant, capability, connection, {
            accountId: account.accountId,
            ...(operation.workflowId ? { workflowId: operation.workflowId } : {}),
            ...(operation.sessionId ? { sessionId: operation.sessionId } : {}),
            now,
          })
          const fingerprints = covered ? scopedRepositories(grant, context.host) : []
          if (fingerprints.length > 0) {
            lists.push({ policyRef: `capability-grant:${grant.id}`, fingerprints })
          }
        }
      }
    } catch {
      // Grants nothing; the plan asks instead.
    }
  }
  return lists
}

/**
 * A Bot installation's repository scope, for a write it publishes without a
 * person: its `publicationMode` is `automatic`, or a person relaxed its run
 * permission to approval-free writes (the broker's `decidedBy: "policy"`).
 * A person set both the scope and the mode in the Bot console.
 */
export function botScopeGrants(
  installation: { id: string },
  repository: string | undefined,
  host?: string
): OutboundPolicyGrantList[] {
  const target = repository ? repositoryOnHost(repository, host) : undefined
  return target
    ? [{ policyRef: `bot-scope:${installation.id}`, fingerprints: [outboundFingerprint(target)] }]
    : []
}

/**
 * An Agent Team's bound repositories that a person consented to publish to:
 * they turned stacked delivery on in the team's settings while those were
 * bound (`githubDeliveryPolicy.consent`). A team a plugin, a template or an
 * automatic team turned on carries no consent, and a repository bound after
 * the consent is not in it; their stacks wait for a person. `repositories`
 * are the bindings' paths with their resolved GitHub repository
 * (`resolveTeamRepo`). Read by the stack publisher's plan.
 */
export function teamDeliveryGrants(
  team: {
    id: string
    config: {
      githubDeliveryPolicy?: AgentTeamGithubDeliveryPolicy
      repositories?: ReadonlyArray<{ path: string }>
      workingDir?: string
    }
  },
  repositories: ReadonlyArray<{ path: string; fullName: string; host?: string }>
): OutboundPolicyGrantList[] {
  const consented = consentedRepositoryPaths(team.config)
  const fingerprints = repositories.flatMap((repository) => {
    if (!consented.has(repository.path)) return []
    const target = repositoryOnHost(repository.fullName, repository.host)
    return target ? [outboundFingerprint(target)] : []
  })
  return fingerprints.length > 0 ? [{ policyRef: `team-delivery:${team.id}`, fingerprints }] : []
}

// ── Browser sites (ADR-0239 phase 2b) ──────────────────────────────────────

/** The ref the global site list grants under. */
export const BROWSER_SITES_POLICY_REF = "browser-sites"

/**
 * The global site list (`agentPermissions.outboundSites`): the sites any
 * browser submission may reach with nobody asking, whichever run makes it.
 * Only the Settings → Security card writes it. An entry that is not a valid
 * `site` grant is dropped, so a hand-edited or partly synced settings object
 * never grants more than a person listed. Read structurally, like the mode,
 * so a settings object from any source can be passed.
 */
export function readOutboundSiteGrants(
  settings: { agentPermissions?: unknown } | null | undefined
): OutboundRecipientGrant[] {
  const permissions = settings?.agentPermissions
  if (!permissions || typeof permissions !== "object") return []
  const list = (permissions as { outboundSites?: unknown }).outboundSites
  if (!Array.isArray(list)) return []
  return list.filter(
    (entry): entry is OutboundRecipientGrant =>
      validateOutboundRecipientGrants([entry]).length === 0 &&
      (entry as OutboundRecipientGrant).recipient.kind === "site"
  )
}

/**
 * The global site list as a `policy` grant, for a browser submission's plan.
 *
 * Intentionally dormant until the browser chokepoints land (ADR-0239 phase 2b
 * WP12): nothing plans a browser submission yet, so nothing calls this. The
 * Security card labels the list "not yet in effect", and
 * `outbound-site-list.test.tsx` pins that label.
 */
export function configuredSiteGrants(
  settings: { agentPermissions?: unknown } | null | undefined
): OutboundPolicyGrantList[] {
  const list = recipientGrantList(BROWSER_SITES_POLICY_REF, readOutboundSiteGrants(settings))
  return list ? [list] : []
}

// ── Handler Bots: the run's plugin code ─────────────────────────────────────

interface LiveBotRun {
  pluginId: string
  installationId: string
  lists: readonly OutboundPolicyGrantList[]
}

const liveBotRuns = new Map<string, LiveBotRun>()

/**
 * Record that a handler Bot of `pluginId` is running: until the returned
 * function is called, that plugin's own deliveries (`ctx.connectors`) may reach
 * the installation's recipients. Keyed by run, so overlapping runs of two
 * installations each count, and ending one leaves the other.
 */
export function beginBotOutboundRun(
  runId: string,
  run: {
    pluginId: string
    installation: { id: string; outboundRecipients?: readonly OutboundRecipientGrant[] }
  }
): () => void {
  const lists = botRecipientGrants(run.installation)
  if (lists.length === 0) return () => undefined
  liveBotRuns.set(runId, {
    pluginId: run.pluginId,
    installationId: run.installation.id,
    lists,
  })
  return () => {
    liveBotRuns.delete(runId)
  }
}

/** The installation lists of `pluginId`'s handler Bots running right now. */
export function runningBotGrantsOf(pluginId: string): OutboundPolicyGrantList[] {
  const lists: OutboundPolicyGrantList[] = []
  for (const run of liveBotRuns.values()) {
    if (run.pluginId === pluginId) lists.push(...run.lists)
  }
  return lists
}

export function __resetRunningBotGrantsForTesting(): void {
  liveBotRuns.clear()
}
