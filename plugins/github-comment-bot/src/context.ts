/**
 * What the model is shown, bounded and with its sources stated.
 *
 * Collection reads through the Bot binding only (repository-scoped, on the
 * bound account's own deployment), never follows a link from a comment, and
 * charges every page to a {@link FetchBudget}. Selection then takes items in
 * a fixed priority — the command, its issue or pull request, the line thread
 * it was written in, the code, recent discussion, CI — and records what it
 * left out, so a truncated review is never presented as a complete one.
 *
 * Every untrusted string is stripped of control sequences here; the host
 * redacts the assembled prompt again before any agent sees it, and the
 * gateway checks each model request on a Cognia route.
 */

import {
  ContextBudgetExceededError,
  FetchBudget,
  findOutputMarker,
  groupReviewThreads,
  sanitizeControlChars,
  selectContext,
  type ContextItem,
  type ContextSelection,
  type GithubReader,
  type Item,
  type ReviewCommentData,
} from "@cognia/github-bot-kit"

import { MARKER_NAMESPACE, type CommandSourceV1 } from "./command-source"

/** Plan §6 limits. None is measured; the stricter host or provider limit wins. */
export const CONTEXT_LIMITS = {
  fetchBytes: 2 * 1024 * 1024,
  pagesPerKind: 10,
  collectMs: 30_000,
  selectedBytes: 256 * 1024,
  selectedTokens: 24_000,
  itemBytes: 32 * 1024,
  diffBytes: 128 * 1024,
  comments: 50,
  files: 300,
} as const

export interface ThreadItem {
  number: number
  title: string
  state: string
  draft: boolean
  isPullRequest: boolean
  url?: string
  headSha?: string
  headRef?: string
  baseRef?: string
  baseSha?: string
  /** The head lives in another repository; its objects are reachable as refs/pull/N/head. */
  fork: boolean
}

/** Per file, the line ranges each side of the diff covers; GitHub accepts review comments only there. */
export type DiffIndex = Record<
  string,
  { LEFT: Array<[number, number]>; RIGHT: Array<[number, number]> }
>

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm

export function indexPatch(patch: string): DiffIndex[string] {
  const ranges: DiffIndex[string] = { LEFT: [], RIGHT: [] }
  for (const match of patch.matchAll(HUNK)) {
    const [left, leftCount, right, rightCount] = [1, 2, 3, 4].map((group) =>
      match[group] === undefined ? 1 : Number(match[group])
    )
    if (leftCount > 0) ranges.LEFT.push([left, left + leftCount - 1])
    if (rightCount > 0) ranges.RIGHT.push([right, right + rightCount - 1])
  }
  return ranges
}

export function inDiff(index: DiffIndex, path: string, line: number, side: "LEFT" | "RIGHT") {
  return (index[path]?.[side] ?? []).some(([start, end]) => line >= start && line <= end)
}

export interface CollectedContext {
  item: ThreadItem
  diffIndex: DiffIndex
  /** What to check out: a PR's pull ref (verified against `sha`), or the default branch tip. */
  checkout: { ref: string; sha: string; targetRef?: string }
  selection: ContextSelection
  /** Whether the code under review fit entirely (always true for a question). */
  complete: boolean
  fetchedBytes: number
}

const clean = (text: string | null | undefined) => sanitizeControlChars(text ?? "")

async function pagesWithin<T>(
  reader: GithubReader,
  budget: FetchBudget,
  kind: string,
  path: string,
  field?: string
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = []
  for (let page = 1; ; page += 1) {
    if (budget.pagesLeft(kind) === 0) return { items, truncated: true }
    const separator = path.includes("?") ? "&" : "?"
    const response = await reader.request<T[] | Record<string, T[]>>(
      `${path}${separator}per_page=100&page=${page}`
    )
    budget.charge(kind, JSON.stringify(response.data ?? null).length)
    const data = field ? (response.data as Record<string, T[]>)[field] : response.data
    if (!Array.isArray(data)) throw new Error(`Invalid GitHub collection: ${path}`)
    items.push(...data)
    if (!/rel="next"/.test(response.headers.link ?? "")) return { items, truncated: false }
  }
}

interface PullFile {
  filename?: string
  status?: string
  additions?: number
  deletions?: number
  patch?: string
}

interface ConversationComment {
  id?: number
  body?: string | null
  user?: { login?: string; type?: string } | null
  created_at?: string
  html_url?: string
}

export function toThreadItem(
  item: Item,
  source: Pick<CommandSourceV1, "threadKind" | "repository">
): ThreadItem {
  const isPullRequest = source.threadKind === "pull_request"
  return {
    number: item.number,
    title: clean(item.title),
    state: item.state,
    draft: Boolean(item.draft),
    isPullRequest,
    ...(item.html_url ? { url: item.html_url } : {}),
    ...(isPullRequest && item.head
      ? {
          headSha: item.head.sha,
          headRef: item.head.ref,
          baseRef: item.base?.ref,
          baseSha: item.base?.sha,
        }
      : {}),
    fork:
      isPullRequest &&
      item.head?.repo?.full_name?.toLowerCase() !== source.repository.toLowerCase(),
  }
}

export async function readThreadItem(
  reader: GithubReader,
  source: Pick<CommandSourceV1, "threadNumber" | "threadKind" | "repository">
): Promise<ThreadItem> {
  const path = `/${source.threadKind === "pull_request" ? "pulls" : "issues"}/${source.threadNumber}`
  return toThreadItem((await reader.request<Item>(path)).data, source)
}

export async function collectContext(
  reader: GithubReader,
  source: CommandSourceV1,
  now: () => number = Date.now
): Promise<CollectedContext> {
  const budget = new FetchBudget(
    {
      maxBytes: CONTEXT_LIMITS.fetchBytes,
      maxPagesPerKind: CONTEXT_LIMITS.pagesPerKind,
      maxDurationMs: CONTEXT_LIMITS.collectMs,
    },
    now
  )
  const items: ContextItem[] = []
  const threadPath = `/${source.threadKind === "pull_request" ? "pulls" : "issues"}/${source.threadNumber}`
  const parent = (await reader.request<Item>(threadPath)).data
  budget.charge("parent", JSON.stringify(parent).length)
  const item = toThreadItem(parent, source)
  const parentUrl = item.url ?? `${source.repository}#${source.threadNumber}`

  items.push({
    id: "command",
    kind: "command",
    source: source.sourceUrl ?? parentUrl,
    priority: 0,
    required: true,
    text: `${source.verb}: ${clean(source.request)}`,
  })
  items.push({
    id: "parent",
    kind: "parent",
    source: parentUrl,
    priority: 1,
    required: true,
    text: [
      `${item.isPullRequest ? "Pull request" : "Issue"} #${item.number}: ${item.title}`,
      `State: ${item.state}${item.draft ? " (draft)" : ""}`,
      ...(item.isPullRequest
        ? [
            `Head: ${item.headRef ?? "?"} @ ${item.headSha ?? "?"}${item.fork ? " (fork)" : ""}`,
            `Base: ${item.baseRef ?? "?"} @ ${item.baseSha ?? "?"}`,
          ]
        : []),
      "",
      clean(parent.body),
    ].join("\n"),
  })

  let complete = true
  const diffIndex: DiffIndex = {}
  if (item.isPullRequest) {
    const reviewComments = await pagesWithin<ReviewCommentData & { diff_hunk?: string }>(
      reader,
      budget,
      "review_comments",
      `/pulls/${source.threadNumber}/comments`
    )
    if (source.sourceKind === "review_comment") {
      const thread = groupReviewThreads(reviewComments.items).find((candidate) =>
        candidate.comments.some((comment) => comment.id === source.sourceId)
      )
      const root = reviewComments.items.find((comment) => String(comment.id) === thread?.id)
      if (thread) {
        items.push({
          id: `thread-${thread.id}`,
          kind: "line_thread",
          source: `${thread.path}:${thread.line}`,
          priority: 2,
          required: true,
          maxBytes: CONTEXT_LIMITS.itemBytes,
          text: [
            `File ${thread.path}, line ${thread.line}`,
            root?.diff_hunk ? `\n${clean(root.diff_hunk)}\n` : "",
            ...thread.comments
              .filter((comment) => !findOutputMarker(comment.body, MARKER_NAMESPACE))
              .map((comment) => `${comment.author}: ${clean(comment.body)}`),
          ].join("\n"),
        })
      }
    }
    const files = await pagesWithin<PullFile>(
      reader,
      budget,
      "files",
      `/pulls/${source.threadNumber}/files`
    )
    const listed = files.items.slice(0, CONTEXT_LIMITS.files)
    if (files.truncated || files.items.length > CONTEXT_LIMITS.files) complete = false
    items.push({
      id: "files",
      kind: "files",
      source: `${parentUrl}/files`,
      priority: 3,
      text: listed
        .map(
          (file) =>
            `${file.status ?? "modified"} ${clean(file.filename)} (+${file.additions ?? 0} -${file.deletions ?? 0})`
        )
        .join("\n"),
    })
    for (const file of listed)
      if (file.filename && typeof file.patch === "string")
        diffIndex[file.filename] = indexPatch(file.patch)
    const patches = listed
      .filter((file) => typeof file.patch === "string")
      .map((file) => `--- ${clean(file.filename)}\n${clean(file.patch)}`)
      .join("\n")
    // GitHub omits `patch` for binary and very large files.
    if (listed.some((file) => file.patch === undefined && file.status !== "removed"))
      complete = false
    items.push({
      id: "diff",
      kind: "diff",
      source: `${parentUrl}/files`,
      priority: 3,
      maxBytes: CONTEXT_LIMITS.diffBytes,
      text: patches,
    })
  }

  const conversation = await pagesWithin<ConversationComment>(
    reader,
    budget,
    "comments",
    `/issues/${source.threadNumber}/comments`
  )
  const recent = conversation.items
    .filter(
      (comment) =>
        String(comment.id) !== source.sourceId &&
        !findOutputMarker(comment.body ?? "", MARKER_NAMESPACE)
    )
    .slice(-CONTEXT_LIMITS.comments)
  recent.forEach((comment, index) => {
    items.push({
      id: `comment-${comment.id ?? index}`,
      kind: "comment",
      source: comment.html_url ?? parentUrl,
      // Newer discussion first among equals.
      priority: 4 + (recent.length - index) / (recent.length + 1),
      text: `${comment.user?.login ?? "unknown"}: ${clean(comment.body)}`,
    })
  })

  if (item.isPullRequest && item.headSha) {
    try {
      const checks = await pagesWithin<{
        name?: string
        status?: string
        conclusion?: string | null
      }>(reader, budget, "checks", `/commits/${item.headSha}/check-runs`, "check_runs")
      const notable = checks.items.filter(
        (check) =>
          check.status !== "completed" ||
          !["success", "skipped", "neutral"].includes(check.conclusion ?? "")
      )
      if (notable.length)
        items.push({
          id: "ci",
          kind: "ci",
          source: `${parentUrl}/checks`,
          priority: 5,
          text: notable
            .map(
              (check) =>
                `${clean(check.name)}: ${check.status}${check.conclusion ? ` / ${check.conclusion}` : ""}`
            )
            .join("\n"),
        })
    } catch (error) {
      // CI is the last and least important item; running out of budget there
      // still leaves a usable context.
      if (!(error instanceof ContextBudgetExceededError)) throw error
    }
  }

  const selection = selectContext(items, {
    maxBytes: CONTEXT_LIMITS.selectedBytes,
    maxTokens: CONTEXT_LIMITS.selectedTokens,
    maxItemBytes: CONTEXT_LIMITS.itemBytes,
  })
  const diff = selection.items.find((entry) => entry.id === "diff")
  if (item.isPullRequest && (!diff || diff.truncated)) complete = false
  if (selection.omitted.files) complete = false

  const checkout = item.isPullRequest
    ? { ref: `refs/pull/${item.number}/head`, sha: item.headSha ?? "" }
    : await defaultBranchTip(reader, budget)
  return { item, diffIndex, checkout, selection, complete, fetchedBytes: budget.fetchedBytes }
}

async function defaultBranchTip(
  reader: GithubReader,
  budget: FetchBudget
): Promise<{ ref: string; sha: string; targetRef: string }> {
  const repository = (await reader.request<{ default_branch?: string }>("")).data
  budget.charge("repository", JSON.stringify(repository).length)
  const branch = repository.default_branch
  if (!branch) throw new Error("The repository has no default branch")
  const commit = (await reader.request<{ sha?: string }>(`/commits/${encodeURIComponent(branch)}`))
    .data
  if (!commit.sha) throw new Error("The default branch did not resolve to a commit")
  return { ref: commit.sha, sha: commit.sha, targetRef: branch }
}
