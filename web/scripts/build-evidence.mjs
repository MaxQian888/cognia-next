#!/usr/bin/env node
/**
 * Build-time evidence collection (ADR-0092 §6).
 *
 * A static export has no request-time runtime, so everything the site claims
 * about releases, the changelog and the repository is materialised here, before
 * `next build`, and stamped with the moment it was read.
 *
 * This script is deliberately I/O only — fetch, filesystem, git. Every decision
 * that could be wrong (is there a release? which asset is the macOS one? how do
 * entries group?) lives in `web/lib/evidence.ts` as pure, unit-tested
 * TypeScript. A script that cannot be run under Jest should not be where the
 * judgement lives.
 *
 * Failure policy: if a fetch fails, the previously committed snapshot is kept
 * and the affected source is recorded in `errors`. The site then renders the
 * older figures under a "last successful read" label instead of showing a zero
 * or failing the build. A network outage must not be able to publish the claim
 * that a project has no contributors.
 *
 *   node web/scripts/build-evidence.mjs
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const REPO_ROOT = join(WEB_ROOT, "..")
const OUT_DIR = join(WEB_ROOT, "content", "generated")
const OUT_FILE = join(OUT_DIR, "evidence.json")

const OWNER = "MaxQian888"
const REPO = "cognia-next"
const API = `https://api.github.com/repos/${OWNER}/${REPO}`

/** GitHub rejects unidentified clients; a token lifts the 60/hour anonymous cap. */
function headers() {
  const base = {
    Accept: "application/vnd.github+json",
    "User-Agent": `${REPO}-website-build`,
    "X-GitHub-Api-Version": "2022-11-28",
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  return token ? { ...base, Authorization: `Bearer ${token}` } : base
}

async function getJson(url) {
  const response = await fetch(url, { headers: headers() })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`)
  return response.json()
}

/** Previously committed snapshot, used when a source is unreachable. */
function readPrevious() {
  if (!existsSync(OUT_FILE)) return null
  try {
    return JSON.parse(readFileSync(OUT_FILE, "utf8"))
  } catch {
    return null
  }
}

/**
 * Parse one changeset file. The format is a YAML-ish frontmatter block naming
 * the package and the bump, then a prose body written for the reader.
 */
export function parseChangeset(id, raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw)
  if (!match) return null
  const [, frontmatter, body] = match
  const bumpMatch = /:\s*(major|minor|patch)\s*$/m.exec(frontmatter)
  const summary = body.trim()
  if (!summary) return null
  return { id, bump: bumpMatch ? bumpMatch[1] : "patch", summary }
}

/**
 * The date a changeset entered the repository — the closest thing to "when did
 * this change land" that does not require a release to exist.
 */
function firstCommitDate(relativePath) {
  try {
    const out = execFileSync(
      "git",
      ["log", "--diff-filter=A", "--follow", "--format=%aI", "-1", "--", relativePath],
      { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim()
    return out || null
  } catch {
    return null
  }
}

function collectChangesets() {
  const dir = join(REPO_ROOT, ".changeset")
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md")
    .map((name) => {
      const id = name.replace(/\.md$/, "")
      const parsed = parseChangeset(id, readFileSync(join(dir, name), "utf8"))
      if (!parsed) return null
      return { ...parsed, date: firstCommitDate(join(".changeset", name)) }
    })
    .filter(Boolean)
}

async function collectRepo() {
  const repo = await getJson(API)
  return {
    stars: repo.stargazers_count ?? 0,
    license: repo.license?.spdx_id ?? null,
    description: repo.description || null,
  }
}

async function collectContributors() {
  // `per_page=1` plus the Link header is the cheap way to a total; without a
  // last page the project has at most one contributor.
  const response = await fetch(`${API}/contributors?per_page=1&anon=false`, { headers: headers() })
  if (!response.ok) throw new Error(`${response.status} for contributors`)
  const link = response.headers.get("link")
  const last = link && /[?&]page=(\d+)>;\s*rel="last"/.exec(link)
  if (last) return Number(last[1])
  const body = await response.json()
  return Array.isArray(body) ? body.length : 0
}

async function collectReleases() {
  const releases = await getJson(`${API}/releases?per_page=10`)
  if (!Array.isArray(releases)) return []
  return releases
    .filter((release) => !release.draft)
    .map((release) => ({
      tagName: release.tag_name,
      name: release.name || release.tag_name,
      prerelease: Boolean(release.prerelease),
      publishedAt: release.published_at,
      htmlUrl: release.html_url,
      // Changesets already aggregates the entries into these notes, so the
      // changelog page reads them instead of parsing CHANGELOG.md twice.
      body: release.body || null,
      assets: (release.assets ?? []).map((asset) => ({
        name: asset.name,
        url: asset.browser_download_url,
        size: asset.size,
      })),
    }))
}

async function main() {
  const previous = readPrevious()
  const errors = []
  const readAt = new Date().toISOString()

  // The changeset feed is local: it never fails for network reasons, so it is
  // always current even when GitHub is unreachable.
  const changesets = collectChangesets()

  let repo = previous?.repo ?? { stars: null, license: null, description: null }
  let contributors = previous?.contributors ?? null
  let releases = previous?.releases ?? []

  const offline = process.env.WEB_EVIDENCE_OFFLINE === "1"
  if (offline) {
    errors.push("offline: kept the previous snapshot for every network source")
  } else {
    for (const [label, run] of [
      ["repo", async () => (repo = await collectRepo())],
      ["contributors", async () => (contributors = await collectContributors())],
      ["releases", async () => (releases = await collectReleases())],
    ]) {
      try {
        await run()
      } catch (error) {
        errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const evidence = {
    // The read time only advances for sources that actually succeeded; the site
    // labels figures with `lastGoodReadAt` when `errors` is non-empty.
    readAt,
    lastGoodReadAt: errors.length === 0 ? readAt : (previous?.lastGoodReadAt ?? null),
    errors,
    repo,
    contributors,
    releases,
    changesets,
  }

  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(OUT_FILE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8")

  const summary = [
    `${changesets.length} changeset entries`,
    `${releases.length} release(s)`,
    repo.stars === null ? "stars unavailable" : `${repo.stars} stars`,
  ].join(" · ")
  console.log(`[evidence] ${summary}`)
  for (const error of errors) console.warn(`[evidence] kept previous value — ${error}`)
}

// Only run when invoked directly, so the parser above can be imported by tests.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main()
}
