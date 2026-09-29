/**
 * GitHub as a sync provider (spec 2026-09-06, D11), for `github-repo`
 * resources in `import` mode.
 *
 * Pull reuses `fetchRepoIssues` (the same incremental `since` walk the mirror
 * uses) and adds three reads: milestones (REST), the repository's Projects v2
 * iterations (GraphQL, only when the binding names a project number) and the
 * most recently updated pull requests, whose titles, bodies and head branches
 * are scanned for `KEY-n` identifiers and `#n` issue numbers so the PR
 * becomes a `github-pr` ref on the issues it names.
 *
 * Push goes through the `github-delivery` plugin's `updateIssue` action, so
 * it lands in the integrations approval queue like every other GitHub write.
 * The engine treats that as `queued` and repeats under the same idempotency
 * key until the remote reflects the change.
 */

import { fetchRepoIssues, type OctokitLike } from "@/lib/github/issues"
import { githubStateToStatus } from "@/lib/issues/sources/github-source"
import {
  GITHUB_DELIVERY_PLUGIN_ID,
  GITHUB_INTEGRATION_ID,
  resolveGithubWritebackAccount,
} from "@/lib/issues/github-writeback"
import { MissingGithubCredentialError } from "@/lib/issues/sync-runner"
import { executeIntegrationAction } from "@/lib/integrations/action-runner"
import { createResolveOctokit } from "@/lib/ai/agent/team/pr-feedback/resolvers"
import type {
  Issue,
  IssueExternalRef,
  IssueProject,
  IssueStatus,
  IssueSyncField,
} from "@/types/issues"
import { statusCategoryOf } from "@/types/issues"
import { isGithubImportBinding } from "../bindings"
import {
  PULL_REQUEST_REF_PROVIDER,
  fetchPullRequestCi,
  pullRequestExternalId,
  pullRequestStateOf,
} from "@/lib/issues/pull-requests"
import type {
  IssueSyncBinding,
  IssueSyncProvider,
  PullOptions,
  PullResult,
  PushOutcome,
  RemoteCycle,
  RemoteIssue,
  RemoteLink,
  RemotePatch,
} from "../types"

export const GITHUB_SYNC_PROVIDER_ID = "github"
export const GITHUB_PR_PROVIDER_ID = PULL_REQUEST_REF_PROVIDER

export const GITHUB_PULL_FIELDS: readonly IssueSyncField[] = [
  "title",
  "description",
  "status",
  "assignee",
  "labels",
  "cycle",
]
export const GITHUB_PUSH_FIELDS: readonly IssueSyncField[] = [
  "title",
  "description",
  "status",
  "assignee",
  "labels",
  "cycle",
]

/** GitHub's login grammar: 1–39 alphanumerics or single hyphens, no leading hyphen. */
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

/**
 * The GitHub login a local issue's assignee stands for, or `undefined` when
 * the assignee is not a GitHub identity.
 *
 * Only an assignee that came FROM GitHub qualifies: import writes it as a
 * `human` actor with the login as its label and no local id. An agent or a
 * workspace member has no GitHub login here, and guessing one from a display
 * name would assign a stranger.
 */
export function githubLoginOfAssignee(issue: Pick<Issue, "assignee">): string | undefined {
  const assignee = issue.assignee
  if (!assignee || assignee.kind !== "human" || assignee.id) return undefined
  const label = assignee.label?.trim()
  return label && GITHUB_LOGIN_RE.test(label) ? label : undefined
}

/**
 * The full assignee list to send for a local single-assignee change.
 *
 * The board mirrors only the FIRST GitHub assignee, so the push replaces that
 * one and keeps the rest — sending just `[login]` would silently unassign
 * everyone else. `null` (nobody locally) clears the issue.
 */
export function nextGithubAssignees(current: readonly string[], login: string | null): string[] {
  if (login === null) return []
  const rest = current
    .slice(1)
    .filter((candidate) => candidate.toLowerCase() !== login.toLowerCase())
  return [login, ...rest]
}

export function milestoneExternalId(number: number): string {
  return `milestone/${number}`
}

export function iterationExternalId(id: string): string {
  return `iteration/${id}`
}

export interface GithubSyncProviderDeps {
  /** Returns null when no credential is available. */
  resolveOctokitOrNull?: (repoFullName: string) => Promise<OctokitLike | null>
  execute?: typeof executeIntegrationAction
  resolveAccount?: typeof resolveGithubWritebackAccount
  /** How many recently updated pull requests to scan for links. */
  pullRequestPageSize?: number
  /**
   * How many open linked pull requests get their CI read per pass. Two
   * requests each, so the sweep's cost stays bounded however busy the repo.
   */
  pullRequestCiLimit?: number
}

interface RawMilestone {
  number: number
  title: string
  state?: string
  due_on?: string | null
  html_url?: string
}

interface RawPull {
  number: number
  title?: string
  body?: string | null
  html_url?: string
  head?: { ref?: string; sha?: string } | null
  state?: string
  merged_at?: string | null
}

interface ProjectV2Response {
  data?: {
    repository?: {
      projectV2?: {
        fields?: {
          nodes?: Array<{
            __typename?: string
            name?: string
            configuration?: {
              iterations?: Array<{ id: string; title: string; startDate: string; duration: number }>
              completedIterations?: Array<{
                id: string
                title: string
                startDate: string
                duration: number
              }>
            }
          }>
        }
        items?: {
          nodes?: Array<{
            content?: { number?: number } | null
            fieldValues?: { nodes?: Array<{ iterationId?: string; title?: string }> }
          }>
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
        }
      } | null
    }
  }
}

const PROJECT_V2_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    projectV2(number: $number) {
      fields(first: 50) {
        nodes {
          __typename
          ... on ProjectV2IterationField {
            name
            configuration {
              iterations { id title startDate duration }
              completedIterations { id title startDate duration }
            }
          }
        }
      }
      items(first: 100, after: $after) {
        nodes {
          content { ... on Issue { number } }
          fieldValues(first: 20) {
            nodes { ... on ProjectV2ItemFieldIterationValue { iterationId title } }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`

const DAY_MS = 24 * 60 * 60 * 1000

function toEpoch(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

/** `KEY-12` mentions of this container plus `#12` issue numbers, from any text. */
export function extractIssueMentions(
  text: string,
  projectKey: string,
  repoFullName: string
): { identifiers: string[]; externalIds: string[] } {
  const identifiers = new Set<string>()
  const externalIds = new Set<string>()
  const keyPattern = new RegExp(`\\b(${projectKey})-(\\d+)\\b`, "gi")
  for (const match of text.matchAll(keyPattern)) {
    identifiers.add(`${match[1].toUpperCase()}-${match[2]}`)
  }
  for (const match of text.matchAll(/(?:^|[^\w/])#(\d+)\b/g)) {
    externalIds.add(`${repoFullName}#${match[1]}`)
  }
  return { identifiers: [...identifiers], externalIds: [...externalIds] }
}

export function toRemoteIssue(
  row: {
    number: number
    title: string
    body?: string
    state: "open" | "closed"
    stateReason?: string
    assigneeLogins: string[]
    labels: Array<{ name: string }>
    htmlUrl: string
    updatedAt: number
    milestoneNumber?: number
    etag?: string
  },
  repoFullName: string,
  iterationByIssue: ReadonlyMap<number, string>
): RemoteIssue {
  const iteration = iterationByIssue.get(row.number)
  return {
    externalId: `${repoFullName}#${row.number}`,
    url: row.htmlUrl,
    label: `${repoFullName}#${row.number}`,
    title: row.title,
    description: row.body ?? "",
    status: githubStateToStatus(row.state, row.stateReason),
    coarseStatus: true,
    assigneeLabel: row.assigneeLogins[0] ?? null,
    labels: row.labels.map((label) => label.name),
    cycleExternalId: iteration
      ? iterationExternalId(iteration)
      : row.milestoneNumber !== undefined
        ? milestoneExternalId(row.milestoneNumber)
        : null,
    remoteUpdatedAt: row.updatedAt,
    ...(row.etag ? { meta: { etag: row.etag } } : {}),
  }
}

/** Board status to the two GitHub states, via the category anchor. */
export function statusToGithubState(status: IssueStatus): {
  state: "open" | "closed"
  state_reason?: "completed" | "not_planned"
} {
  const category = statusCategoryOf(status)
  if (category === "completed") return { state: "closed", state_reason: "completed" }
  if (category === "canceled") return { state: "closed", state_reason: "not_planned" }
  return { state: "open" }
}

/**
 * The `updateIssue` action input for a patch. Milestones only, never
 * iterations. `assignees` is the complete list to set, computed by the caller
 * from the remote's current assignees (see {@link nextGithubAssignees}); the
 * patch's own `assignee` label is not sent directly.
 */
export function toUpdateIssueInput(
  repoFullName: string,
  issueNumber: number,
  patch: RemotePatch,
  assignees?: readonly string[]
): Record<string, unknown> {
  const input: Record<string, unknown> = { repoFullName, issueNumber }
  if (assignees !== undefined) input.assignees = [...assignees]
  if (patch.title !== undefined) input.title = patch.title
  if (patch.description !== undefined) input.body = patch.description ?? ""
  if (patch.status !== undefined) {
    const mapped = statusToGithubState(patch.status)
    input.state = mapped.state
    if (mapped.state_reason) input.stateReason = mapped.state_reason
  }
  if (patch.labels !== undefined) input.labels = [...patch.labels]
  if (patch.cycleExternalId !== undefined) {
    if (patch.cycleExternalId === null) input.milestone = null
    else if (patch.cycleExternalId.startsWith("milestone/")) {
      input.milestone = Number(patch.cycleExternalId.slice("milestone/".length))
    }
  }
  return input
}

async function fetchMilestones(
  octokit: OctokitLike,
  owner: string,
  repo: string
): Promise<RemoteCycle[]> {
  const response = await octokit.request("GET /repos/{owner}/{repo}/milestones", {
    owner,
    repo,
    state: "all",
    per_page: 100,
  })
  const rows = Array.isArray(response.data) ? (response.data as RawMilestone[]) : []
  return rows.map((row) => ({
    externalId: milestoneExternalId(row.number),
    kind: "milestone" as const,
    name: row.title,
    status: row.state === "closed" ? ("completed" as const) : ("active" as const),
    ...(toEpoch(row.due_on) !== undefined ? { endsAt: toEpoch(row.due_on) } : {}),
    ...(row.html_url ? { url: row.html_url } : {}),
  }))
}

async function fetchProjectV2(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  number: number
): Promise<{ cycles: RemoteCycle[]; iterationByIssue: Map<number, string> }> {
  const cycles = new Map<string, RemoteCycle>()
  const iterationByIssue = new Map<number, string>()
  let after: string | null = null
  for (let page = 0; page < 20; page += 1) {
    // Octokit hands back the GraphQL envelope as `data`, so the payload the
    // query returned sits one level down at `data.data`.
    const response = (await octokit.request("POST /graphql", {
      query: PROJECT_V2_QUERY,
      variables: { owner, repo, number, after },
    })) as { data: ProjectV2Response }
    const project = response.data?.data?.repository?.projectV2
    if (!project) break
    for (const field of project.fields?.nodes ?? []) {
      const configuration = field?.configuration
      if (!configuration) continue
      for (const [list, status] of [
        [configuration.iterations ?? [], "planned"],
        [configuration.completedIterations ?? [], "completed"],
      ] as const) {
        for (const iteration of list) {
          const startsAt = toEpoch(iteration.startDate)
          cycles.set(iteration.id, {
            externalId: iterationExternalId(iteration.id),
            kind: "cycle",
            name: iteration.title,
            status,
            ...(startsAt !== undefined
              ? { startsAt, endsAt: startsAt + iteration.duration * DAY_MS }
              : {}),
          })
        }
      }
    }
    for (const item of project.items?.nodes ?? []) {
      const issueNumber = item?.content?.number
      const iteration = item?.fieldValues?.nodes?.find((value) => value?.iterationId)
      if (typeof issueNumber === "number" && iteration?.iterationId) {
        iterationByIssue.set(issueNumber, iteration.iterationId)
      }
    }
    const pageInfo = project.items?.pageInfo
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break
    after = pageInfo.endCursor
  }
  // The active iteration is the one whose window holds today.
  const now = Date.now()
  for (const cycle of cycles.values()) {
    if (cycle.status === "planned" && cycle.startsAt !== undefined && cycle.endsAt !== undefined) {
      if (cycle.startsAt <= now && now < cycle.endsAt) cycle.status = "active"
    }
  }
  return { cycles: [...cycles.values()], iterationByIssue }
}

async function fetchPullLinks(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  binding: IssueSyncBinding,
  perPage: number,
  ciLimit: number
): Promise<RemoteLink[]> {
  const repoFullName = `${owner}/${repo}`
  const response = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
    owner,
    repo,
    state: "all",
    sort: "updated",
    direction: "desc",
    per_page: perPage,
  })
  const rows = Array.isArray(response.data) ? (response.data as RawPull[]) : []
  const links: RemoteLink[] = []
  let ciReads = 0
  for (const pull of rows) {
    const text = [pull.title ?? "", pull.body ?? "", pull.head?.ref ?? ""].join("\n")
    const mentions = extractIssueMentions(text, binding.projectKey, repoFullName)
    if (mentions.identifiers.length === 0 && mentions.externalIds.length === 0) continue
    const prState = pullRequestStateOf(pull)
    // Only an open pull request's CI can still move, and the newest-updated
    // come first, so the budget goes where a wakeup is most likely waiting.
    let ciState: RemoteLink["ciState"]
    if (prState === "open" && pull.head?.sha && ciReads < ciLimit) {
      ciReads += 1
      try {
        ciState = await fetchPullRequestCi(octokit, owner, repo, pull.head.sha)
      } catch {
        // A token without checks access, or a transient error, leaves this
        // PR's CI unread this pass; the links and states still land.
        ciState = undefined
      }
    }
    links.push({
      provider: GITHUB_PR_PROVIDER_ID,
      externalId: pullRequestExternalId(repoFullName, pull.number),
      ...(pull.html_url ? { url: pull.html_url } : {}),
      label: `PR #${pull.number}${pull.title ? `: ${pull.title}` : ""}`,
      mentionsIdentifiers: mentions.identifiers,
      mentionsExternalIds: mentions.externalIds,
      ...(prState ? { prState } : {}),
      ...(ciState ? { ciState } : {}),
    })
  }
  return links
}

export function createGithubSyncProvider(deps: GithubSyncProviderDeps = {}): IssueSyncProvider {
  const resolveOctokitOrNull =
    deps.resolveOctokitOrNull ??
    (createResolveOctokit() as (repoFullName: string) => Promise<OctokitLike | null>)
  const execute = deps.execute ?? executeIntegrationAction
  const resolveAccount = deps.resolveAccount ?? resolveGithubWritebackAccount
  const pullPageSize = deps.pullRequestPageSize ?? 50
  const pullCiLimit = deps.pullRequestCiLimit ?? 10

  async function octokitFor(repoFullName: string): Promise<OctokitLike> {
    const octokit = await resolveOctokitOrNull(repoFullName)
    if (!octokit) throw new MissingGithubCredentialError(repoFullName)
    return octokit
  }

  return {
    id: GITHUB_SYNC_PROVIDER_ID,
    label: "GitHub",
    pullFields: GITHUB_PULL_FIELDS,
    pushFields: GITHUB_PUSH_FIELDS,

    resolveBindings(containers: readonly IssueProject[]): IssueSyncBinding[] {
      const seen = new Set<string>()
      const bindings: IssueSyncBinding[] = []
      for (const container of [...containers].sort((a, b) => a.id.localeCompare(b.id))) {
        for (const resource of container.resources) {
          if (!isGithubImportBinding(resource) || resource.kind !== "github-repo") continue
          if (seen.has(resource.repoFullName)) continue
          seen.add(resource.repoFullName)
          bindings.push({
            providerId: GITHUB_SYNC_PROVIDER_ID,
            projectId: container.projectId,
            issueProjectId: container.id,
            projectKey: container.key,
            resource,
            key: resource.repoFullName,
          })
        }
      }
      return bindings
    },

    async pull(binding: IssueSyncBinding, options: PullOptions): Promise<PullResult> {
      const resource = binding.resource
      if (resource.kind !== "github-repo") throw new Error("not a github-repo binding")
      const [owner, repo] = resource.repoFullName.split("/")
      if (!owner || !repo) throw new Error(`Invalid repository: ${resource.repoFullName}`)
      const octokit = await octokitFor(resource.repoFullName)

      const [issues, milestones, project] = await Promise.all([
        fetchRepoIssues(octokit, {
          repoFullName: resource.repoFullName,
          ...(options.since !== undefined && !options.full
            ? { since: new Date(options.since).toISOString() }
            : {}),
        }),
        fetchMilestones(octokit, owner, repo),
        resource.sync?.projectV2Number
          ? fetchProjectV2(octokit, owner, repo, resource.sync.projectV2Number)
          : Promise.resolve({
              cycles: [] as RemoteCycle[],
              iterationByIssue: new Map<number, string>(),
            }),
      ])
      const links = await fetchPullLinks(octokit, owner, repo, binding, pullPageSize, pullCiLimit)

      return {
        items: issues.rows.map((row) =>
          toRemoteIssue(row, resource.repoFullName, project.iterationByIssue)
        ),
        cycles: [...milestones, ...project.cycles],
        links,
        notModified: issues.notModified,
        truncated: issues.truncated,
      }
    },

    async push(
      binding: IssueSyncBinding,
      ref: IssueExternalRef,
      patch: RemotePatch,
      issue: Issue,
      context: { idempotencyKey: string }
    ): Promise<PushOutcome> {
      const resource = binding.resource
      if (resource.kind !== "github-repo") throw new Error("not a github-repo binding")
      const hash = ref.externalId.lastIndexOf("#")
      const issueNumber = Number(ref.externalId.slice(hash + 1))
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        throw new Error(`Not a GitHub issue ref: ${ref.externalId}`)
      }

      // An assignee goes out only when it names a GitHub login (or nobody);
      // an agent or member assignee stays local, as it always has.
      let assignees: string[] | undefined
      if (patch.assignee !== undefined) {
        const login = patch.assignee === null ? null : githubLoginOfAssignee(issue)
        if (login !== undefined) {
          const [owner, repo] = resource.repoFullName.split("/")
          const current = await (
            await octokitFor(resource.repoFullName)
          ).request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
            owner,
            repo,
            issue_number: issueNumber,
          })
          const logins = (
            (current.data as { assignees?: Array<{ login?: string }> } | undefined)?.assignees ?? []
          )
            .map((assignee) => assignee.login)
            .filter((value): value is string => typeof value === "string")
          assignees = nextGithubAssignees(logins, login)
        }
      }
      const input = toUpdateIssueInput(resource.repoFullName, issueNumber, patch, assignees)
      // Nothing left to send (the patch was only a local-only assignee).
      if (Object.keys(input).length <= 2) return { status: "applied" }

      const account = await resolveAccount()
      if (!account) throw new MissingGithubCredentialError(resource.repoFullName)
      const job = await execute(GITHUB_DELIVERY_PLUGIN_ID, {
        integrationId: GITHUB_INTEGRATION_ID,
        accountId: account.id,
        actionId: "updateIssue",
        input,
        source: "workflow",
        idempotencyKey: context.idempotencyKey,
      })
      return job.status === "succeeded"
        ? { status: "applied" }
        : { status: "queued", jobId: job.id }
    },
  }
}
