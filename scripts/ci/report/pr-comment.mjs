#!/usr/bin/env node
/**
 * Post the CI report to a pull request — updating the same comment each time
 * rather than adding one per run.
 *
 * Runs from `report.yml`, which is triggered by `workflow_run`. That matters:
 * the main pipeline is called from ci.yml with the repository's read-only
 * default token, and a reusable workflow may not request more scope than its
 * caller holds — asking for `pull-requests: write` inside it is what made the
 * entire pipeline fail to compile once already. A `workflow_run` workflow
 * runs in the base repository's context with its own permissions, so this is
 * the one place the write can legally happen, and it works for fork and
 * Dependabot PRs too.
 *
 * Usage:
 *   node scripts/ci/report/pr-comment.mjs --pr 123 --body-file report.md
 */

import { readFileSync } from "node:fs"

import { COMMENT_MARKER } from "./render.mjs"

const API = "https://api.github.com"

/** Pure. @param {string[]} argv */
export function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === "--pr") args.pr = argv[++i]
    else if (key === "--body-file") args.bodyFile = argv[++i]
    else throw new Error(`Unknown argument: ${key}`)
  }
  if (!args.pr) throw new Error("--pr is required")
  if (!args.bodyFile) throw new Error("--body-file is required")
  return args
}

/**
 * Find this tool's previous comment. Pure.
 *
 * Matching on the marker rather than the author means a repository that later
 * swaps the token identity keeps updating the same comment.
 *
 * @param {Array<{ id: number, body?: string }>} comments
 * @param {string} [marker]
 */
export function findExistingComment(comments, marker = COMMENT_MARKER) {
  return (comments ?? []).find((c) => typeof c.body === "string" && c.body.includes(marker)) ?? null
}

/** Build the request for an upsert. Pure — no I/O, so it is fully testable. */
export function buildRequest({ repo, pr, existingId, body }) {
  return existingId
    ? { method: "PATCH", url: `${API}/repos/${repo}/issues/comments/${existingId}`, body: { body } }
    : { method: "POST", url: `${API}/repos/${repo}/issues/${pr}/comments`, body: { body } }
}

async function ghJson(fetchImpl, token, url, init = {}) {
  const res = await fetchImpl(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) throw new Error(`GitHub API ${init.method ?? "GET"} ${url} → ${res.status}`)
  return res.status === 204 ? null : res.json()
}

export async function upsertComment({ repo, pr, body, token, fetchImpl = fetch }) {
  const comments = await ghJson(
    fetchImpl,
    token,
    `${API}/repos/${repo}/issues/${pr}/comments?per_page=100`
  )
  const existing = findExistingComment(comments)
  const req = buildRequest({ repo, pr, existingId: existing?.id, body })
  await ghJson(fetchImpl, token, req.url, { method: req.method, body: JSON.stringify(req.body) })
  return { updated: Boolean(existing), id: existing?.id ?? null }
}

export async function main(argv = []) {
  const args = parseArgs(argv)
  const token = process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPOSITORY
  if (!token || !repo) {
    console.error("[pr-comment] GITHUB_TOKEN and GITHUB_REPOSITORY must be set")
    return 1
  }

  const body = readFileSync(args.bodyFile, "utf8")
  const { updated } = await upsertComment({ repo, pr: args.pr, body, token })
  console.log(`[pr-comment] ${updated ? "updated" : "created"} the report comment on #${args.pr}`)
  return 0
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("pr-comment.mjs")
) {
  process.exit(await main(process.argv.slice(2)))
}
