import { execFile } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const MAX_PAGES = 20
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
const MAX_REPORT_BYTES = 8 * 1024 * 1024
const REPORT_BUDGET_MS = 45_000
const knownArtifact = /^(?:jest-shard-\d+|coverage-report|playwright-json|bundle-size)$/

function identifier(value) {
  if (!/^[1-9]\d*$/.test(String(value))) throw new Error("Invalid GitHub identifier")
  return String(value)
}

function workflowRunsPath(workflowId) {
  if (workflowId !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(String(workflowId)))
    throw new Error("Invalid GitHub workflow identifier")
  return workflowId === undefined
    ? "/actions/runs"
    : `/actions/workflows/${encodeURIComponent(workflowId)}/runs`
}

async function boundedBody(response, limit) {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel()
    throw new Error("GitHub response size limit exceeded")
  }
  const chunks = []
  let size = 0
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > limit) throw new Error("GitHub response size limit exceeded")
      chunks.push(Buffer.from(chunk))
    }
  }
  return Buffer.concat(chunks)
}

function artifactTarget(url) {
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    (url.hostname === "api.github.com" ||
      url.hostname === "objects.githubusercontent.com" ||
      url.hostname === "github.com" ||
      url.hostname.endsWith(".blob.core.windows.net") ||
      url.hostname.endsWith(".actions.githubusercontent.com"))
  )
}

/** Read-only GitHub.com evidence adapter. The alternate origin is loopback-only for tests. */
export function createGitHubClient({
  repository,
  token,
  fetchImpl = fetch,
  apiUrl = "https://api.github.com",
  timeoutMs = 30_000,
  maxResponseBytes = MAX_REPORT_BYTES,
  now = () => performance.now(),
}) {
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(repository)
  )
    throw new Error("Invalid GitHub repository")
  if (typeof token !== "string" || !token.trim()) throw new Error("Missing GitHub token")
  let origin
  try {
    origin = new URL(apiUrl)
  } catch {
    throw new Error("Invalid GitHub API origin")
  }
  const loopback =
    origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
  if (
    (!loopback && origin.origin !== "https://api.github.com") ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("Invalid GitHub API origin")
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000 ||
    !Number.isInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > MAX_REPORT_BYTES
  )
    throw new Error("Invalid GitHub request limits")
  const base = `/repos/${repository}`

  async function request(url, { archive = false, allow404 = false } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      let target = new URL(url, origin)
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        const headers = {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        }
        // Signed archive URLs are bearer credentials themselves. Never forward the token.
        if (target.origin === origin.origin) headers.Authorization = `Bearer ${token}`
        const response = await fetchImpl(target.toString(), {
          method: "GET",
          headers,
          signal: controller.signal,
          redirect: "manual",
        })
        if (archive && [301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location")
          await response.body?.cancel()
          if (!location || redirects === 3) throw new Error("GitHub artifact redirect rejected")
          const next = new URL(location, target)
          if (!artifactTarget(next)) throw new Error("GitHub artifact redirect rejected")
          target = next
          continue
        }
        if (allow404 && response.status === 404) {
          await response.body?.cancel()
          return null
        }
        if (!response.ok) {
          await response.body?.cancel()
          throw new Error(`GitHub API request failed (${response.status})`)
        }
        const bytes = await boundedBody(response, archive ? MAX_ARCHIVE_BYTES : maxResponseBytes)
        if (archive) return bytes
        try {
          return JSON.parse(bytes.toString("utf8"))
        } catch {
          throw new Error("GitHub API returned invalid JSON")
        }
      }
    } catch (error) {
      if (controller.signal.aborted) throw new Error("GitHub API request timed out")
      if (
        /^GitHub (?:API request failed \(\d{3}\)|response size limit exceeded|API returned invalid JSON|artifact redirect rejected)$/.test(
          error.message
        )
      )
        throw error
      throw new Error("GitHub API request failed")
    } finally {
      clearTimeout(timer)
    }
  }

  async function pages(path, field, query = {}) {
    const results = []
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const params = new URLSearchParams(
        Object.entries(query).filter(([, value]) => value !== undefined)
      )
      params.set("per_page", "100")
      params.set("page", String(page))
      const data = await request(`${base}${path}?${params}`)
      const values = field ? data?.[field] : data
      if (!Array.isArray(values) || values.length > 100)
        throw new Error("GitHub API returned invalid collection")
      results.push(...values)
      if (
        values.length < 100 ||
        (Number.isInteger(data.total_count) && results.length >= data.total_count)
      )
        return results
    }
    throw new Error("GitHub API pagination limit exceeded")
  }

  const client = {
    async getRun(id, attempt) {
      return request(
        `${base}/actions/runs/${identifier(id)}${attempt === undefined ? "" : `/attempts/${identifier(attempt)}`}`
      )
    },
    async getJobs(id, attempt) {
      return pages(`/actions/runs/${identifier(id)}/attempts/${identifier(attempt)}/jobs`, "jobs")
    },
    async listRuns({ workflowId, branch, event, created } = {}) {
      return pages(workflowRunsPath(workflowId), "workflow_runs", { branch, event, created })
    },
    // This is intentionally incomplete history, unlike listRuns. Callers must
    // never infer recovery or suppress a failure from an absent predecessor.
    async listRecentRuns({ workflowId, branch, event } = {}, limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error("Invalid GitHub recent history limit")
      const path = workflowRunsPath(workflowId)
      const params = new URLSearchParams(
        Object.entries({ branch, event }).filter(([, value]) => value !== undefined)
      )
      params.set("per_page", String(limit))
      params.set("page", "1")
      const data = await request(`${base}${path}?${params}`)
      if (!Array.isArray(data?.workflow_runs) || data.workflow_runs.length > limit)
        throw new Error("GitHub API returned invalid collection")
      return data.workflow_runs
    },
    async listArtifacts({ name, runId } = {}) {
      return pages(
        runId === undefined ? "/actions/artifacts" : `/actions/runs/${identifier(runId)}/artifacts`,
        "artifacts",
        { name }
      )
    },
    async getRelease(tag) {
      if (typeof tag !== "string" || !tag || tag === "." || tag === ".." || tag.length > 256)
        throw new Error("Invalid GitHub tag")
      return request(`${base}/releases/tags/${encodeURIComponent(tag)}`, { allow404: true })
    },
    async getPullRequestsForCommit(sha) {
      if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error("Invalid GitHub commit identifier")
      return pages(`/commits/${sha}/pulls`)
    },
    async readReport(runId, { attempt = 1, startedAt, finishedAt } = {}) {
      const result = { junitDocs: [], playwrightJson: null, bundle: null, warnings: [] }
      const artifacts = await client.listArtifacts({ runId })
      const start = startedAt ? Date.parse(startedAt) : NaN
      const finish = finishedAt ? Date.parse(finishedAt) : NaN
      if (attempt > 1 && !Number.isFinite(start)) {
        result.warnings.push("Report artifacts omitted: source attempt start is unavailable")
        return result
      }
      let selected = artifacts.filter((item) => knownArtifact.test(item.name))
      selected = selected.filter((item) => {
        const created = Date.parse(item.created_at)
        return (
          !item.expired &&
          (!Number.isFinite(start) || created >= start) &&
          (!Number.isFinite(finish) || created <= finish) &&
          (!item.workflow_run?.id || String(item.workflow_run.id) === String(runId))
        )
      })
      // Merged coverage reports contain the same JUnit shards; never count twice.
      if (selected.some((item) => /^jest-shard-\d+$/.test(item.name)))
        selected = selected.filter((item) => item.name !== "coverage-report")
      if (selected.length > 66) throw new Error("GitHub report artifact count limit exceeded")
      const dir = await mkdtemp(join(tmpdir(), "cognia-feishu-report-"))
      let remaining = MAX_REPORT_BYTES
      const deadline = now() + REPORT_BUDGET_MS
      const budgetExceeded = new Error("Report processing deadline exceeded")
      const checkDeadline = () => {
        if (now() >= deadline) throw budgetExceeded
      }
      try {
        for (const artifact of selected) {
          try {
            checkDeadline()
            if (
              !Number.isFinite(artifact.size_in_bytes) ||
              artifact.size_in_bytes > MAX_ARCHIVE_BYTES ||
              remaining <= 0
            )
              throw new Error("limit")
            const archive = await request(
              `${base}/actions/artifacts/${identifier(artifact.id)}/zip`,
              { archive: true }
            )
            const path = join(dir, "report.zip")
            await writeFile(path, archive, { mode: 0o600 })
            checkDeadline()
            const { stdout: listing } = await execFileAsync("unzip", ["-Z1", path], {
              timeout: 5_000,
              maxBuffer: 256 * 1024,
              encoding: "utf8",
            })
            const names = listing.trimEnd().split("\n")
            let files
            if (/^jest-shard-\d+$/.test(artifact.name))
              files = names.filter((name) => name === `junit-shard-${artifact.name.slice(11)}.xml`)
            else if (artifact.name === "coverage-report")
              files = names.filter((name) => /^(?:junit|junit-shard-\d+)\.xml$/.test(name))
            else
              files = names.filter(
                (name) =>
                  name ===
                  (artifact.name === "playwright-json" ? "report.json" : "bundle-size.json")
              )
            if (!files.length || new Set(files).size !== files.length || files.length > 64)
              throw new Error("invalid archive")
            // stdout-only extraction cannot follow archive symlinks or write traversal paths.
            const extracted = []
            for (const file of files) {
              checkDeadline()
              if (remaining <= 0) throw new Error("limit")
              const { stdout } = await execFileAsync("unzip", ["-p", path, file], {
                timeout: 5_000,
                maxBuffer: remaining,
                encoding: "buffer",
              })
              remaining -= stdout.length
              extracted.push(stdout.toString("utf8"))
            }
            if (artifact.name.startsWith("jest-shard-") || artifact.name === "coverage-report")
              result.junitDocs.push(...extracted)
            else {
              const parsed = JSON.parse(extracted[0])
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
                throw new Error("invalid report")
              if (artifact.name === "playwright-json") result.playwrightJson = parsed
              else result.bundle = parsed
            }
          } catch (error) {
            if (error === budgetExceeded) {
              result.warnings.push(
                "Report processing time budget exceeded; remaining evidence omitted"
              )
              break
            }
            result.warnings.push(`Report artifact unavailable: ${artifact.name}`)
          }
        }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
      if (!result.junitDocs.length)
        result.warnings.push("JUnit report unavailable for this attempt")
      if (!result.playwrightJson)
        result.warnings.push("Playwright report unavailable for this attempt")
      if (!result.bundle) result.warnings.push("Bundle report unavailable for this attempt")
      return result
    },
  }
  return client
}
