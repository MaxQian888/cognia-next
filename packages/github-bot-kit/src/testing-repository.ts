/**
 * A mutable fake GitHub repository for Bot suites: one issue (#7) and one pull
 * request (#8) on `acme/widgets`, a write-permission author, the Bot's own
 * identity, and a read router over all of it. Shared by the first-party Bots'
 * suites and the host's end-to-end suites, which drive the same Bot through
 * the real host planes.
 *
 * Framework-free and test-only, like the rest of the `./testing` subpath.
 */
import { githubResponse, routeGithubRequests } from "./testing"

export const REPOSITORY = "acme/widgets"
export const REPOSITORY_ID = "4242"
export const NOW = Date.parse("2026-10-12T10:00:00Z")
export const HEAD = "a".repeat(40)
export const BOT = { id: 900, login: "cognia-bot[bot]" }
export const AUTHOR = { id: 42, login: "octo-cat", type: "User" }

export interface FakeGithub {
  comments: Map<number, Record<string, unknown>>
  reviewComments: Map<number, Record<string, unknown>>
  reviews: Map<number, Record<string, unknown>>
  items: Map<number, Record<string, unknown>>
  permissions: Map<string, { permission: string; id: number }>
  files: Array<Record<string, unknown>>
  checks: Array<Record<string, unknown>>
  viewer: { id: number; login: string }
  /** Overrides by repository-relative path, checked first. */
  overrides: Map<string, unknown>
}

export function issueComment(
  id: number,
  body: string,
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    body,
    created_at: new Date(NOW - 60_000).toISOString(),
    updated_at: new Date(NOW - 60_000).toISOString(),
    html_url: `https://github.com/${REPOSITORY}/issues/7#issuecomment-${id}`,
    issue_url: `https://api.github.com/repos/${REPOSITORY}/issues/7`,
    user: AUTHOR,
    ...over,
  }
}

export function fakeGithub(): FakeGithub {
  return {
    comments: new Map(),
    reviewComments: new Map(),
    reviews: new Map(),
    items: new Map([
      [
        7,
        {
          number: 7,
          title: "Crash on empty input",
          body: "It crashes",
          state: "open",
          html_url: `https://github.com/${REPOSITORY}/issues/7`,
        },
      ],
      [
        8,
        {
          number: 8,
          title: "Validate input",
          body: "Adds validation",
          state: "open",
          draft: false,
          html_url: `https://github.com/${REPOSITORY}/pull/8`,
          pull_request: { url: "x" },
          head: { sha: HEAD, ref: "feature", repo: { full_name: REPOSITORY } },
          base: { sha: "b".repeat(40), ref: "main", repo: { full_name: REPOSITORY } },
        },
      ],
    ]),
    permissions: new Map([[AUTHOR.login, { permission: "write", id: AUTHOR.id }]]),
    files: [
      {
        filename: "src/validate.ts",
        status: "modified",
        additions: 2,
        deletions: 0,
        patch:
          "@@ -1,3 +1,5 @@\n export function validate(x) {\n+  if (!x) throw new Error('empty')\n+  return true\n }",
      },
    ],
    checks: [],
    viewer: BOT,
    overrides: new Map(),
  }
}

export function routeFake(github: FakeGithub) {
  return routeGithubRequests(REPOSITORY, (path) => {
    const bare = path.split("?")[0]
    if (github.overrides.has(bare)) return github.overrides.get(bare)
    if (path === "/user") return github.viewer
    if (path === "") return { id: Number(REPOSITORY_ID), default_branch: "main" }
    if (bare === "/commits/main") return { sha: "c".repeat(40) }
    let match = /^\/collaborators\/([^/]+)\/permission$/.exec(bare)
    if (match) {
      const grant = github.permissions.get(decodeURIComponent(match[1]))
      return grant
        ? { permission: grant.permission, role_name: grant.permission, user: { id: grant.id } }
        : githubResponse({ message: "Not Found" }, { status: 404 })
    }
    match = /^\/issues\/comments\/(\d+)$/.exec(bare)
    if (match) return github.comments.get(Number(match[1])) ?? githubResponse({}, { status: 404 })
    match = /^\/pulls\/comments\/(\d+)$/.exec(bare)
    if (match)
      return github.reviewComments.get(Number(match[1])) ?? githubResponse({}, { status: 404 })
    match = /^\/pulls\/(\d+)\/reviews\/(\d+)$/.exec(bare)
    if (match) return github.reviews.get(Number(match[2])) ?? githubResponse({}, { status: 404 })
    match = /^\/(issues|pulls)\/(\d+)$/.exec(bare)
    if (match) return github.items.get(Number(match[2])) ?? githubResponse({}, { status: 404 })
    match = /^\/issues\/(\d+)\/comments$/.exec(bare)
    if (match) return [...github.comments.values()]
    match = /^\/pulls\/(\d+)\/comments$/.exec(bare)
    if (match) return [...github.reviewComments.values()]
    match = /^\/pulls\/(\d+)\/files$/.exec(bare)
    if (match) return github.files
    match = /^\/pulls\/(\d+)\/reviews$/.exec(bare)
    if (match) return [...github.reviews.values()]
    if (/^\/commits\/[0-9a-f]{40}\/check-runs$/.test(bare)) return { check_runs: github.checks }
    if (bare === "/issues/comments") return [...github.comments.values()]
    if (bare === "/pulls/comments") return [...github.reviewComments.values()]
    if (bare === "/pulls") return [...github.items.values()].filter((item) => item.head)
    return undefined
  })
}
