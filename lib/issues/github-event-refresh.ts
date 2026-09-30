/**
 * GitHub webhook → issue board freshness.
 *
 * The board reads Dexie only, and Dexie was refreshed only by the 15-minute
 * `github-issue-sync` schedule and the "Sync now" button. A user who set up a
 * full webhook still watched an `issues.closed` sit on the board as open for up
 * to a quarter of an hour: webhook events reached workflows, the inbox and bots,
 * and nothing that wrote the mirror.
 *
 * This is that consumer. It does not project the webhook payload into rows
 * itself — the mirror's `since` watermark is the newest `updatedAt` it holds,
 * so writing one fresh row out of band would move the watermark past edits the
 * poll has not fetched yet and lose them for good. Instead an event schedules
 * the same incremental refresh the schedule runs, for the one repository the
 * event names, coalesced over a short window so a burst (a bulk label edit
 * fires one event per issue) costs one read.
 *
 * The exception is an issue that LEFT the repository (`issues.transferred`,
 * `issues.deleted`): no read of this repository will ever mention it again, so
 * its mirror row is removed directly from the payload's issue number.
 *
 * Scope: issue bindings name a bare `owner/name`, which means github.com. An
 * event from an account on a GitHub Enterprise server is ignored here rather
 * than refreshing a github.com repository that happens to share the name.
 */

import type { IntegrationEventEnvelope } from "@/types/plugin/plugin-integration"
import { getIntegrationAccount } from "@/lib/db/integrations"
import { deleteGithubIssues } from "@/lib/db/github-issue-mirror"
import { GITHUB_DOT_COM, parseGithubHost } from "@/lib/github/host"
import { integrationApiBaseUrl } from "@/lib/integrations/action-runner"
import { GITHUB_DELIVERY_PLUGIN_ID } from "./github-writeback"
import {
  MissingGithubCredentialError,
  resolveWorkspaceGithubBindings,
  type WorkspaceGithubBinding,
} from "./sync-runner"
import { syncRepoIssues } from "./github-sync"
import { createResolveOctokit } from "@/lib/ai/agent/team/pr-feedback/resolvers"
import type { OctokitLike } from "@/lib/github/issues"
import { getIssueSyncRegistry } from "./sync/registry"
import { reconcileBinding } from "./sync/engine"
import { resolveWorkspaceSyncBindings } from "./sync/runner"
import { GITHUB_SYNC_PROVIDER_ID } from "./sync/providers/github"
import type { IssueSyncBinding } from "./sync/types"

/** Coalescing window for a burst of events on one repository. */
export const GITHUB_EVENT_REFRESH_DEBOUNCE_MS = 2_000

/** Event families whose delivery can change what the board shows. */
const REFRESHING_PREFIXES = ["issues.", "issue_comment."] as const
/** Actions after which the issue no longer belongs to the repository. */
const DEPARTED = new Set(["issues.transferred", "issues.deleted"])

export interface GithubEventRefreshDeps {
  accountHostId: (pluginId: string, accountId: string) => Promise<string | undefined>
  mirrorBindings: () => Promise<WorkspaceGithubBinding[]>
  importBindings: () => Promise<IssueSyncBinding[]>
  refreshMirror: (binding: WorkspaceGithubBinding) => Promise<unknown>
  reconcileImport: (binding: IssueSyncBinding) => Promise<unknown>
  removeFromMirror: (repoFullName: string, numbers: number[]) => Promise<unknown>
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  onError: (repoFullName: string, error: unknown) => void
}

async function defaultAccountHostId(
  pluginId: string,
  accountId: string
): Promise<string | undefined> {
  const account = await getIntegrationAccount(pluginId, accountId)
  if (!account) return undefined
  const base = await integrationApiBaseUrl(account)
  // Not host-aware (or unresolvable) means the plugin's default: github.com.
  return (base ? parseGithubHost(base) : GITHUB_DOT_COM)?.id
}

function defaultDeps(): GithubEventRefreshDeps {
  const resolveOctokit = createResolveOctokit() as (
    repoFullName: string
  ) => Promise<OctokitLike | null>
  return {
    accountHostId: defaultAccountHostId,
    mirrorBindings: () => resolveWorkspaceGithubBindings(),
    importBindings: async () =>
      (await resolveWorkspaceSyncBindings()).filter(
        (binding) => binding.providerId === GITHUB_SYNC_PROVIDER_ID
      ),
    refreshMirror: (binding) =>
      syncRepoIssues(binding, {
        resolveOctokit: async (repoFullName) => {
          const octokit = await resolveOctokit(repoFullName)
          if (!octokit) throw new MissingGithubCredentialError(repoFullName)
          return octokit
        },
      }),
    reconcileImport: async (binding) => {
      const provider = getIssueSyncRegistry().get(binding.providerId)
      if (!provider) return undefined
      return reconcileBinding(binding, provider)
    },
    removeFromMirror: (repoFullName, numbers) => deleteGithubIssues(repoFullName, numbers),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    onError: (repoFullName, error) =>
      console.warn("GitHub event issue refresh failed", { repoFullName, error }),
  }
}

function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function issueNumberOf(event: IntegrationEventEnvelope): number | undefined {
  const issue = (event.payload as { issue?: { number?: unknown } } | undefined)?.issue
  const number = issue?.number
  return typeof number === "number" && Number.isInteger(number) && number > 0 ? number : undefined
}

export class GithubEventIssueRefresher {
  private readonly timers = new Map<string, unknown>()
  /** One refresh chain per repository, so two windows never overlap. */
  private readonly chains = new Map<string, Promise<void>>()

  constructor(private readonly deps: GithubEventRefreshDeps = defaultDeps()) {}

  /** True when the event can change the issue board. */
  static relevant(event: IntegrationEventEnvelope): boolean {
    return (
      event.pluginId === GITHUB_DELIVERY_PLUGIN_ID &&
      event.resource?.kind === "repository" &&
      typeof event.resource.id === "string" &&
      REFRESHING_PREFIXES.some((prefix) => event.eventType.startsWith(prefix))
    )
  }

  /**
   * React to one published event. Never throws: this consumer is best-effort,
   * like bot delivery, and must not fail the event for workflows or the inbox.
   */
  async handle(event: IntegrationEventEnvelope): Promise<void> {
    if (!GithubEventIssueRefresher.relevant(event)) return
    const repoFullName = event.resource!.id
    try {
      const hostId = await this.deps.accountHostId(event.pluginId, event.accountId)
      if (hostId !== GITHUB_DOT_COM.id) return
      if (DEPARTED.has(event.eventType)) {
        const number = issueNumberOf(event)
        const bound = (await this.deps.mirrorBindings()).find((binding) =>
          sameRepo(binding.repoFullName, repoFullName)
        )
        // The bound spelling, not the payload's: the mirror key is the one
        // the binding was synced under.
        if (number !== undefined && bound) {
          await this.deps.removeFromMirror(bound.repoFullName, [number])
        }
      }
      this.schedule(repoFullName)
    } catch (error) {
      this.deps.onError(repoFullName, error)
    }
  }

  /** Repositories with a refresh waiting to fire. */
  pending(): string[] {
    return [...this.timers.keys()]
  }

  private schedule(repoFullName: string): void {
    const key = repoFullName.toLowerCase()
    const existing = this.timers.get(key)
    if (existing !== undefined) this.deps.clearTimer(existing)
    this.timers.set(
      key,
      this.deps.setTimer(() => {
        this.timers.delete(key)
        void this.enqueue(key, repoFullName)
      }, GITHUB_EVENT_REFRESH_DEBOUNCE_MS)
    )
  }

  private enqueue(key: string, repoFullName: string): Promise<void> {
    const previous = this.chains.get(key) ?? Promise.resolve()
    const next = previous.then(() => this.refresh(repoFullName))
    this.chains.set(key, next)
    return next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key)
    })
  }

  /** Refresh every binding of the repository, mirror and import alike. */
  async refresh(repoFullName: string): Promise<void> {
    try {
      const [mirror, imported] = await Promise.all([
        this.deps.mirrorBindings(),
        this.deps.importBindings(),
      ])
      for (const binding of mirror.filter((b) => sameRepo(b.repoFullName, repoFullName))) {
        await this.deps.refreshMirror(binding)
      }
      for (const binding of imported.filter((b) => sameRepo(b.key, repoFullName))) {
        await this.deps.reconcileImport(binding)
      }
    } catch (error) {
      this.deps.onError(repoFullName, error)
    }
  }
}

let singleton: GithubEventIssueRefresher | undefined

/** The process-wide refresher `publishIntegrationEvent` feeds. */
export function getGithubEventIssueRefresher(): GithubEventIssueRefresher {
  if (!singleton) singleton = new GithubEventIssueRefresher()
  return singleton
}

export function resetGithubEventIssueRefresherForTesting(): void {
  singleton = undefined
}
