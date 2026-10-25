"use client"

/**
 * The shadow report, live (ADR-0239): the receipts enforcement would change,
 * folded by `buildShadowReport`, with the names this device can put on them.
 *
 * Recipients are named from what the device already holds: every conversation
 * a connector has a delivery target for, every bound session, every
 * repository the device works with (`loadKnownRepositories`), and every entry
 * on a list a person wrote. Sites are named from the built-in browser's
 * history, the sites passwords are saved for, the browser profiles' domain
 * grants, and the lists. Nothing is fetched from a platform.
 *
 * The GitHub integration accounts are read with their lists and web hosts, so
 * a repository row can be allowed into the account its write went through, or
 * into one the person picks.
 *
 * The global site list lives in the settings, not the database, so the hook
 * reads it from the settings store and builds the report again when it
 * changes: a site allowed from the report drops out of it.
 */

import { useEffect, useMemo, useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import type {
  ActionReviewReceipt,
  OutboundRecipientGrant,
} from "@cognia/agent-config-types/action-review"
import { loadKnownRepositories } from "@/hooks/outbound/use-known-repositories"
import type { IntegrationAccountRow } from "@/lib/db/integration-types"
import { ensureBootCapability } from "@/lib/boot/capabilities"
import { getDb } from "@/lib/db/schema"
import {
  getIntegrationRegistryRevision,
  getRegisteredIntegration,
  subscribeIntegrationRegistry,
} from "@/lib/integrations/registry"
import { readOutboundSiteGrants } from "@/lib/policy/action-review/configured-grants"
import {
  conversationTarget,
  siteTarget,
  type OutboundTarget,
} from "@/lib/policy/action-review/outbound-targets"
import {
  buildShadowReport,
  type ShadowGithubAccount,
  type ShadowReport,
} from "@/lib/policy/action-review/shadow-report"
import { useSettingsStore } from "@/stores/settings"

export interface ShadowReportView {
  report: ShadowReport
  /** Connector instance display names, by adapter id. */
  adapterNames: ReadonlyMap<string, string>
  /** Scheduled task names, by task id. */
  taskNames: ReadonlyMap<string, string>
  /** Session titles of known conversations, by normalized recipient. */
  conversationTitles: ReadonlyMap<string, string>
  /** GitHub integration account labels, by account id. */
  accountNames: ReadonlyMap<string, string>
  /** Agent Team names, by team id. */
  teamNames: ReadonlyMap<string, string>
}

/** Read everything the report needs, once. Exported for its test. */
export async function loadShadowReport(
  siteList: readonly OutboundRecipientGrant[] = []
): Promise<ShadowReportView> {
  const db = getDb()
  const [receipts, states, sessions, adapters, bots, tasks, accounts, teams, known, sites] =
    await Promise.all([
      db.actionReviewReceipts
        .filter((row) => {
          const plan = row.request.plan
          return !!plan && !plan.enforced && plan.outcome !== "allow"
        })
        .toArray(),
      db.connectorConversationStates.toCollection().primaryKeys(),
      db.sessions.filter((session) => session.platformBinding != null).toArray(),
      db.adapterInstances.toArray(),
      db.botInstallations.toArray(),
      loadTaskNames(),
      db.integrationAccounts.toArray(),
      db.agentTeams.toArray(),
      loadKnownRepositories().catch(() => ({
        repositories: [],
        accountHosts: new Map<string, string>(),
      })),
      loadKnownSites(),
    ])

  const candidates: OutboundTarget[] = []
  const conversationTitles = new Map<string, string>()
  for (const key of states as string[]) {
    const target = conversationTarget(key)
    if (target) candidates.push(target)
  }
  for (const session of sessions) {
    const key = session.platformBinding?.conversationKey
    const target = key ? conversationTarget(key) : undefined
    if (!target) continue
    candidates.push(target)
    const title = session.title?.trim()
    if (title && !conversationTitles.has(target.recipient)) {
      conversationTitles.set(target.recipient, title)
    }
  }

  const botLists = new Map<string, readonly OutboundRecipientGrant[]>()
  for (const bot of bots) {
    botLists.set(bot.id, bot.outboundRecipients ?? [])
    for (const grant of bot.outboundRecipients ?? []) candidates.push(grant.recipient)
  }
  const adapterLists = new Map<string, readonly OutboundRecipientGrant[]>()
  const adapterNames = new Map<string, string>()
  for (const adapter of adapters) {
    adapterLists.set(adapter.id, adapter.outboundRecipients ?? [])
    adapterNames.set(adapter.id, adapter.displayName || adapter.id)
    for (const grant of adapter.outboundRecipients ?? []) candidates.push(grant.recipient)
  }

  for (const repository of known.repositories) candidates.push(repository.target)
  const githubAccounts = new Map<string, ShadowGithubAccount>()
  const accountNames = new Map<string, string>()
  for (const account of await githubAccountsOf(accounts)) {
    const host = known.accountHosts.get(account.id)
    githubAccounts.set(account.id, {
      pluginId: account.pluginId,
      ...(host ? { host } : {}),
      list: account.outboundRecipients ?? [],
    })
    accountNames.set(account.id, account.label || account.id)
    for (const grant of account.outboundRecipients ?? []) candidates.push(grant.recipient)
  }

  candidates.push(...sites)
  for (const grant of siteList) candidates.push(grant.recipient)

  return {
    report: buildShadowReport({
      receipts: receipts as ActionReviewReceipt[],
      candidates,
      botLists,
      adapterLists,
      githubAccounts,
      siteList,
    }),
    adapterNames,
    taskNames: tasks,
    conversationTitles,
    accountNames,
    teamNames: new Map(teams.map((team) => [team.id, team.name || team.id])),
  }
}

/** The accounts of a GitHub integration, as the planner reads them for `gh`. */
async function githubAccountsOf(
  accounts: readonly IntegrationAccountRow[]
): Promise<IntegrationAccountRow[]> {
  const { isGithubIntegration } = await import("@/lib/policy/action-review/github-targets")
  return accounts.filter((account) => {
    const registered = getRegisteredIntegration(account.pluginId, account.integrationId)
    return registered ? isGithubIntegration(registered.definition) : false
  })
}

/** The sites this device has been to or holds something for. */
async function loadKnownSites(): Promise<OutboundTarget[]> {
  const db = getDb()
  // A table the account's database does not have yet names nothing.
  const read = <T>(rows: Promise<T[]>): Promise<T[]> => rows.catch(() => [])
  const [history, credentials, domains] = await Promise.all([
    read(db.browserHistory.toArray()),
    read(db.browserCredentialMeta.toArray()),
    read(db.browserDomainGrants.toArray()),
  ])
  const urls = [
    ...history.map((row) => row.url),
    ...credentials.map((row) => row.origin),
    // A domain grant names a host; a wildcard names no one site.
    ...domains
      .filter((row) => !row.domain.includes("*"))
      .flatMap((row) => [`https://${row.domain}`, `http://${row.domain}`]),
  ]
  return urls.flatMap((url) => siteTarget(url) ?? [])
}

async function loadTaskNames(): Promise<Map<string, string>> {
  try {
    const { schedulerDb } = await import("@/lib/scheduler/scheduler-db")
    const tasks = await schedulerDb.getAllTasks()
    return new Map(tasks.map((task) => [task.id, task.name]))
  } catch {
    // Names are decoration; a report without them still says what it found.
    return new Map()
  }
}

/**
 * `undefined` while the first read is in flight, or when `enabled` is false.
 *
 * Which accounts are GitHub accounts comes from the integration registry,
 * which a plugin fills when it loads. The plugin runtime boots on demand
 * (Settings does not ask for it), so the report asks for it, and reads again
 * whenever the registry changes: the first read may come before the plugin.
 */
export function useShadowReport(enabled = true): ShadowReportView | undefined {
  const settings = useSettingsStore((s) => s.settings)
  const siteList = useMemo(() => readOutboundSiteGrants(settings), [settings])
  const siteKey = useMemo(
    () => siteList.map((grant) => grant.recipient.recipient).join("\n"),
    [siteList]
  )
  useEffect(() => {
    if (!enabled) return
    // A runtime that fails to boot leaves the GitHub accounts unnamed, no more.
    void ensureBootCapability("plugin-runtime").catch(() => undefined)
  }, [enabled])
  const registryRevision = useSyncExternalStore(
    subscribeIntegrationRegistry,
    getIntegrationRegistryRevision,
    () => 0
  )
  return useLiveQuery(
    async () => (enabled && typeof window !== "undefined" ? loadShadowReport(siteList) : undefined),
    // `siteKey` stands for `siteList`: a new settings object with the same sites reads nothing.
    [enabled, registryRevision, siteKey]
  )
}
