"use client"

/**
 * The GitHub repositories this device knows, for picking recipients
 * (ADR-0239 phase 2).
 *
 * A repository list is typed as `owner/repo`, which is easy to get wrong, so
 * the picker offers the repositories this device already works with: the
 * integration subscriptions (`resourceKind: "repository"`), the Bots'
 * repository scopes, the repositories recent integration jobs wrote to
 * (`repoFullName`), and the repositories Agent Teams with stacked delivery
 * publish to. Each is named on the web host of the account it goes through,
 * so a GitHub Enterprise repository is not offered as a github.com one.
 */

import { useEffect, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { getDb } from "@/lib/db/schema"
import {
  outboundRecipientId,
  repositoryOnHost,
  type OutboundTarget,
} from "@/lib/policy/action-review/outbound-targets"
import { stackedDeliveryOn } from "@/lib/stack/team-policy"
import type { AgentTeamGithubDeliveryPolicy } from "@/types/agent/agent-team-runtime"

export interface KnownRepository {
  /** The repository target a list entry names. */
  target: OutboundTarget
  /** `owner/repo`, with its host when it is not github.com. */
  name: string
  /** The newest sighting, for ordering. */
  lastSeenAt: number
}

/** What the known repositories are read from. */
export interface KnownRepositorySources {
  subscriptions: ReadonlyArray<{
    accountId: string
    resourceKind?: string
    resourceId?: string
    updatedAt: string
  }>
  installations: ReadonlyArray<{
    config: Record<string, unknown>
    credentialBindings: Record<string, { integrationAccountId?: string }>
    updatedAt: number
  }>
  jobs: ReadonlyArray<{ accountId: string; input: Record<string, unknown>; updatedAt: string }>
  /** The resolved repositories of teams that publish stacks, with their host. */
  teamRepositories: ReadonlyArray<{ fullName: string; host?: string; updatedAt: number }>
  /** Each integration account's web host (`githubWebHost`), when known. */
  accountHosts: ReadonlyMap<string, string>
}

/** How many recent integration jobs are read for repositories. */
const RECENT_JOBS = 200
/** How many stacked-delivery teams have their repositories resolved. */
const RECENT_TEAMS = 10

function time(value: string | number | undefined): number {
  if (typeof value === "number") return value
  const parsed = value ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Pure: the repositories in these sources, newest first. `accountId` narrows
 * them to one integration account's (subscriptions, Bots bound to it, its
 * jobs); teams name no account and are left out then.
 */
export function knownRepositoriesOf(
  sources: KnownRepositorySources,
  options: { accountId?: string } = {}
): KnownRepository[] {
  const byRecipient = new Map<string, KnownRepository>()
  const add = (
    value: unknown,
    host: string | undefined,
    seenAt: number,
    accountId: string | undefined
  ) => {
    if (typeof value !== "string" || !value.trim()) return
    if (options.accountId && accountId !== options.accountId) return
    const target = repositoryOnHost(value, host)
    if (!target) return
    const known = byRecipient.get(target.recipient)
    if (known && known.lastSeenAt >= seenAt) return
    byRecipient.set(target.recipient, {
      target,
      name: outboundRecipientId(target),
      lastSeenAt: seenAt,
    })
  }

  for (const subscription of sources.subscriptions) {
    if (subscription.resourceKind !== "repository") continue
    add(
      subscription.resourceId,
      sources.accountHosts.get(subscription.accountId),
      time(subscription.updatedAt),
      subscription.accountId
    )
  }
  for (const installation of sources.installations) {
    const repository = installation.config.repository ?? installation.config.repoFullName
    const accountIds = Object.values(installation.credentialBindings)
      .map((binding) => binding.integrationAccountId)
      .filter((id): id is string => typeof id === "string")
    const accountId = options.accountId
      ? accountIds.find((id) => id === options.accountId)
      : accountIds[0]
    add(
      repository,
      accountId ? sources.accountHosts.get(accountId) : undefined,
      installation.updatedAt,
      accountId
    )
  }
  for (const job of sources.jobs) {
    add(
      job.input.repoFullName,
      sources.accountHosts.get(job.accountId),
      time(job.updatedAt),
      job.accountId
    )
  }
  if (!options.accountId) {
    for (const team of sources.teamRepositories) {
      add(team.fullName, team.host, team.updatedAt, undefined)
    }
  }
  return [...byRecipient.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
}

interface StoredSources {
  subscriptions: KnownRepositorySources["subscriptions"]
  installations: KnownRepositorySources["installations"]
  jobs: KnownRepositorySources["jobs"]
  accounts: ReadonlyArray<{ id: string; providerId: string; authSessionId: string }>
  teamPaths: ReadonlyArray<{ path: string; updatedAt: number }>
}

async function readStoredSources(): Promise<StoredSources> {
  const db = getDb()
  const [subscriptions, installations, jobs, accounts, teams] = await Promise.all([
    db.integrationSubscriptions.toArray(),
    db.botInstallations.toArray(),
    db.integrationActionJobs.orderBy("updatedAt").reverse().limit(RECENT_JOBS).toArray(),
    db.integrationAccounts.toArray(),
    db.agentTeams.orderBy("updatedAt").reverse().toArray(),
  ])
  const teamPaths: { path: string; updatedAt: number }[] = []
  const seenPaths = new Set<string>()
  for (const team of teams) {
    if (teamPaths.length >= RECENT_TEAMS) break
    const policy = team.config?.githubDeliveryPolicy as AgentTeamGithubDeliveryPolicy | undefined
    if (!stackedDeliveryOn(policy)) continue
    const bindings = team.config.repositories?.length
      ? team.config.repositories.map((binding) => binding.path)
      : team.config.workingDir
        ? [team.config.workingDir]
        : []
    for (const path of bindings) {
      if (seenPaths.has(path)) continue
      seenPaths.add(path)
      teamPaths.push({ path, updatedAt: team.updatedAt })
    }
  }
  return { subscriptions, installations, jobs, accounts, teamPaths }
}

/** Each account's web host, for the accounts that name one. */
async function resolveAccountHosts(
  accounts: StoredSources["accounts"]
): Promise<Map<string, string>> {
  const [{ integrationApiBaseUrl }, { githubWebHost }] = await Promise.all([
    import("@/lib/integrations/action-runner"),
    import("@/lib/policy/action-review/github-targets"),
  ])
  const hosts = new Map<string, string>()
  await Promise.all(
    accounts.map(async (account) => {
      const base = await integrationApiBaseUrl(account).catch(() => undefined)
      hosts.set(account.id, githubWebHost(base))
    })
  )
  return hosts
}

/** The GitHub repository of each team binding's checkout, where it has one. */
async function resolveTeamRepositories(
  paths: StoredSources["teamPaths"]
): Promise<KnownRepositorySources["teamRepositories"]> {
  if (paths.length === 0) return []
  const { createResolveTeamRepo } = await import("@/lib/ai/agent/team/pr-feedback/resolvers")
  const resolve = createResolveTeamRepo()
  const resolved = await Promise.all(
    paths.map(async ({ path, updatedAt }) => {
      const repo = await resolve(path).catch(() => null)
      return repo ? { fullName: repo.fullName, host: repo.host.id, updatedAt } : undefined
    })
  )
  return resolved.filter((entry) => entry !== undefined)
}

/**
 * Once: the repositories this device knows, and each integration account's
 * web host. For a reader that is not live (the shadow report).
 */
export async function loadKnownRepositories(): Promise<{
  repositories: KnownRepository[]
  accountHosts: ReadonlyMap<string, string>
}> {
  const stored = await readStoredSources()
  const [accountHosts, teamRepositories] = await Promise.all([
    resolveAccountHosts(stored.accounts).catch(() => new Map<string, string>()),
    resolveTeamRepositories(stored.teamPaths).catch(
      () => [] as KnownRepositorySources["teamRepositories"]
    ),
  ])
  return {
    repositories: knownRepositoriesOf({
      subscriptions: stored.subscriptions,
      installations: stored.installations,
      jobs: stored.jobs,
      teamRepositories,
      accountHosts,
    }),
    accountHosts,
  }
}

/** Live: the repositories this device knows, optionally through one account. */
export function useKnownRepositories(accountId?: string): KnownRepository[] {
  const stored = useLiveQuery(readStoredSources, [])
  const [accountHosts, setAccountHosts] = useState<ReadonlyMap<string, string>>(new Map())
  const [teamRepositories, setTeamRepositories] = useState<
    KnownRepositorySources["teamRepositories"]
  >([])

  const accountKey = stored?.accounts.map((account) => account.id).join("|") ?? ""
  const teamKey = stored?.teamPaths.map((entry) => entry.path).join("|") ?? ""

  useEffect(() => {
    if (!stored) return
    let cancelled = false
    void resolveAccountHosts(stored.accounts)
      .then((hosts) => {
        if (!cancelled) setAccountHosts(hosts)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // Re-resolved when the accounts change, not on every live-query tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey])

  useEffect(() => {
    if (!stored) return
    let cancelled = false
    void resolveTeamRepositories(stored.teamPaths)
      .then((repositories) => {
        if (!cancelled) setTeamRepositories(repositories)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamKey])

  return useMemo(
    () =>
      stored
        ? knownRepositoriesOf(
            {
              subscriptions: stored.subscriptions,
              installations: stored.installations,
              jobs: stored.jobs,
              teamRepositories,
              accountHosts,
            },
            accountId ? { accountId } : {}
          )
        : [],
    [accountHosts, accountId, stored, teamRepositories]
  )
}
