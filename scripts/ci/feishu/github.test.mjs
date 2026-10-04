import assert from "node:assert/strict"
import { createServer } from "node:http"
import { execFile } from "node:child_process"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { createGitHubClient } from "./github.mjs"

async function server(t, handler) {
  const instance = createServer(handler)
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve))
  t.after(() => {
    instance.closeAllConnections()
    return new Promise((resolve) => instance.close(resolve))
  })
  return `http://127.0.0.1:${instance.address().port}`
}

test("GET evidence uses authentication, source attempt and encoded parameters", async (t) => {
  const requests = []
  const apiUrl = await server(t, (req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization, method: req.method })
    res.setHeader("content-type", "application/json")
    res.end(
      JSON.stringify(
        req.url.includes("/jobs")
          ? { jobs: [{ id: 7 }] }
          : req.url.includes("/artifacts")
            ? { artifacts: [] }
            : req.url.includes("/runs?")
              ? { workflow_runs: [] }
              : { id: 42 }
      )
    )
  })
  const client = createGitHubClient({ repository: "owner/repo", token: "private-token", apiUrl })
  assert.equal((await client.getRun(42)).id, 42)
  assert.deepEqual(await client.getJobs(42, 2), [{ id: 7 }])
  await client.listRuns({
    workflowId: "ci.yml",
    branch: "feature/a",
    created: "2026-10-01..2026-10-03",
  })
  await client.listArtifacts({ name: "delivery-42", runId: 42 })
  assert.ok(requests.every((r) => r.method === "GET" && r.auth === "Bearer private-token"))
  assert.equal(
    requests[1].url,
    "/repos/owner/repo/actions/runs/42/attempts/2/jobs?per_page=100&page=1"
  )
  assert.match(
    requests[2].url,
    /workflows\/ci.yml\/runs\?branch=feature%2Fa&created=2026-10-01\.\.2026-10-03/
  )
  assert.match(requests[3].url, /runs\/42\/artifacts\?name=delivery-42/)
})

test("paginates all evidence and explicitly rejects a truncated collection", async () => {
  let pages = 0
  const client = createGitHubClient({
    repository: "owner/repo",
    token: "token",
    fetchImpl: async () => {
      pages += 1
      return Response.json({
        artifacts: Array.from({ length: pages === 1 ? 100 : 1 }, (_, i) => ({
          id: i + 100 * (pages - 1),
        })),
      })
    },
  })
  assert.equal((await client.listArtifacts({ name: "receipt" })).length, 101)
  assert.equal(pages, 2)
  const infinite = createGitHubClient({
    repository: "owner/repo",
    token: "token",
    fetchImpl: async () => Response.json({ artifacts: Array(100).fill({ id: 1 }) }),
  })
  await assert.rejects(infinite.listArtifacts(), /pagination limit/)
})

test("recent history explicitly returns one bounded page even when older runs exist", async () => {
  const calls = []
  const client = createGitHubClient({
    repository: "owner/repo",
    token: "token",
    fetchImpl: async (url) => {
      calls.push(url)
      return Response.json({
        total_count: 3000,
        workflow_runs: Array.from({ length: 100 }, (_, i) => ({ id: 3000 - i })),
      })
    },
  })
  assert.equal(
    (await client.listRecentRuns({ workflowId: "ci.yml", branch: "dev", event: "push" })).length,
    100
  )
  assert.equal(calls.length, 1)
  assert.match(calls[0], /workflows\/ci.yml\/runs\?branch=dev&event=push&per_page=100&page=1$/)
  await assert.rejects(client.listRecentRuns({}, 101), /limit/)
})

test("404 is absent only for releases and safe errors never reveal body, URL or token", async (t) => {
  const apiUrl = await server(t, (req, res) => {
    res.statusCode = req.url.includes("releases") ? 404 : 403
    res.end("private-token https://secret-url")
  })
  const client = createGitHubClient({ repository: "owner/repo", token: "private-token", apiUrl })
  assert.equal(await client.getRelease("v1/2"), null)
  await assert.rejects(
    client.getRun(42),
    (error) => error.message === "GitHub API request failed (403)"
  )
})

test("bounds response bodies and request deadlines, including slow streaming", async (t) => {
  const apiUrl = await server(t, (req, res) => {
    if (req.url.includes("/43")) {
      res.writeHead(200)
      res.write("{")
      return
    }
    res.end(JSON.stringify({ data: "x".repeat(2000) }))
  })
  const client = createGitHubClient({
    repository: "owner/repo",
    token: "token",
    apiUrl,
    maxResponseBytes: 1024,
    timeoutMs: 30,
  })
  await assert.rejects(client.getRun(42), /response size limit/)
  await assert.rejects(client.getRun(43), /timed out/)
})

test("rejects invalid origins, repository traversal, missing token and invalid identifiers before requests", async () => {
  for (const repository of ["owner/../repo", "owner/repo/path", "/repo", "owner/.git", "owner/.."])
    assert.throws(() => createGitHubClient({ repository, token: "token" }), /repository/)
  for (const apiUrl of [
    "https://evil.example",
    "https://api.github.com.evil.example",
    "http://api.github.com",
    "http://localhost.evil.example",
    "https://token@api.github.com",
  ])
    assert.throws(
      () => createGitHubClient({ repository: "owner/repo", token: "token", apiUrl }),
      /origin/
    )
  assert.throws(() => createGitHubClient({ repository: "owner/repo", token: "" }), /token/)
  const client = createGitHubClient({
    repository: "owner/repo",
    token: "token",
    fetchImpl: async () => {
      throw new Error("Unexpected request")
    },
  })
  await assert.rejects(client.getRun("../secrets"), /identifier/)
  await assert.rejects(client.getJobs(42, 0), /identifier/)
  await assert.rejects(client.listRuns({ workflowId: ".." }), /identifier/)
  await assert.rejects(client.getRelease(".."), /tag/)
})

async function zip(t, files) {
  const dir = await mkdtemp(join(tmpdir(), "feishu-evidence-test-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content)
  await promisify(execFile)("zip", ["-q", "archive.zip", ...Object.keys(files)], { cwd: dir })
  return readFile(join(dir, "archive.zip"))
}

test("reads only bounded known report files, without coverage or duplicate merged JUnit", async (t) => {
  const junit =
    '<testsuites tests="1"><testsuite tests="1"><testcase name="passing"/></testsuite></testsuites>'
  const archives = {
    1: await zip(t, { "junit-shard-1.xml": junit, "coverage-final.json": "ignored" }),
    2: await zip(t, { "report.json": JSON.stringify({ stats: { expected: 2 } }) }),
    3: await zip(t, { "bundle-size.json": JSON.stringify({ totalBytes: 100 }) }),
  }
  const artifacts = [
    "jest-shard-1",
    "playwright-json",
    "bundle-size",
    "coverage-report",
    "untrusted",
  ].map((name, index) => ({
    id: index + 1,
    name,
    size_in_bytes: 100,
    created_at: "2026-10-03T01:10:00Z",
    workflow_run: { id: 42 },
  }))
  const calls = []
  const client = createGitHubClient({
    repository: "owner/repo",
    token: "token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      if (url.includes("/zip")) return new Response(archives[url.match(/artifacts\/(\d+)\/zip/)[1]])
      return Response.json({ artifacts })
    },
  })
  const report = await client.readReport(42, {
    attempt: 2,
    startedAt: "2026-10-03T01:00:00Z",
    finishedAt: "2026-10-03T02:00:00Z",
  })
  assert.deepEqual(report, {
    junitDocs: [junit],
    playwrightJson: { stats: { expected: 2 } },
    bundle: { totalBytes: 100 },
    warnings: [],
  })
  assert.equal(calls.length, 4)
})

test("never forwards auth across approved archive redirects and rejects attacker redirects", async (t) => {
  const archive = await zip(t, { "report.json": '{"stats":{}}' })
  for (const target of [
    "https://objects.githubusercontent.com/signed?secret=abc",
    "https://evil.example/secret",
    "http://127.0.0.1/private",
  ]) {
    let downloads = 0
    const client = createGitHubClient({
      repository: "owner/repo",
      token: "private-token",
      fetchImpl: async (url, options) => {
        if (url.endsWith("/zip"))
          return new Response(null, { status: 302, headers: { location: target } })
        if (url.startsWith("https://api.github.com"))
          return Response.json({
            artifacts: [{ id: 1, name: "playwright-json", size_in_bytes: 100 }],
          })
        downloads += 1
        assert.equal(options.headers.Authorization, undefined)
        return new Response(archive)
      },
    })
    const report = await client.readReport(42)
    if (target.startsWith("https://objects.githubusercontent.com")) {
      assert.equal(downloads, 1)
      assert.deepEqual(report.playwrightJson, { stats: {} })
    } else {
      assert.equal(downloads, 0)
      assert.equal(report.playwrightJson, null)
      assert.ok(report.warnings.includes("Report artifact unavailable: playwright-json"))
    }
  }
})

test("omits stale, expired, wrong-run and future artifacts and refuses ambiguous attempt timing", async () => {
  let downloads = 0
  const client = createGitHubClient({
    repository: "owner/repo",
    token: "token",
    fetchImpl: async (url) => {
      if (url.endsWith("/zip")) {
        downloads += 1
        throw new Error("should not download")
      }
      return Response.json({
        artifacts: [
          { id: 1, name: "jest-shard-1", created_at: "2026-10-02T01:00:00Z" },
          { id: 2, name: "playwright-json", created_at: "2026-10-03T01:00:00Z", expired: true },
          { id: 3, name: "bundle-size", created_at: "2026-10-04T01:00:00Z" },
          {
            id: 4,
            name: "jest-shard-2",
            created_at: "2026-10-03T01:00:00Z",
            workflow_run: { id: 43 },
          },
        ],
      })
    },
  })
  const report = await client.readReport(42, {
    attempt: 2,
    startedAt: "2026-10-03T00:00:00Z",
    finishedAt: "2026-10-03T02:00:00Z",
  })
  assert.equal(report.junitDocs.length, 0)
  assert.equal(report.warnings.length, 3)
  assert.equal(downloads, 0)
  assert.match((await client.readReport(42, { attempt: 2 })).warnings[0], /start is unavailable/)
})

test("oversized uncompressed reports and invalid JSON become missing evidence without raw diagnostics", async (t) => {
  const archives = {
    1: await zip(t, { "report.json": "private-content-not-json" }),
    2: await zip(t, { "bundle-size.json": "x".repeat(8 * 1024 * 1024 + 1) }),
  }
  const client = createGitHubClient({
    repository: "owner/repo",
    token: "token",
    fetchImpl: async (url) => {
      if (url.endsWith("/zip")) return new Response(archives[url.match(/artifacts\/(\d+)\/zip/)[1]])
      return Response.json({
        artifacts: [
          { id: 1, name: "playwright-json", size_in_bytes: 100 },
          { id: 2, name: "bundle-size", size_in_bytes: 100 },
        ],
      })
    },
  })
  const report = await client.readReport(42)
  assert.equal(report.playwrightJson, null)
  assert.equal(report.bundle, null)
  assert.ok(!JSON.stringify(report).includes("private-content"))
  assert.equal(report.warnings.length, 5)
})

test("cumulative report deadline preserves completed evidence and stops remaining archive work", async (t) => {
  const junit = '<testsuite><testcase name="passing"/></testsuite>'
  const archive = await zip(t, { "junit-shard-1.xml": junit })
  let time = 0
  const downloads = []
  const client = createGitHubClient({
    repository: "owner/repo",
    token: "token",
    now: () => time,
    fetchImpl: async (url) => {
      if (url.endsWith("/zip")) {
        const id = Number(url.match(/artifacts\/(\d+)\/zip/)[1])
        downloads.push(id)
        time += 25_000
        return new Response(archive)
      }
      return Response.json({
        artifacts: [
          { id: 1, name: "jest-shard-1", size_in_bytes: 100 },
          { id: 2, name: "playwright-json", size_in_bytes: 100 },
          { id: 3, name: "bundle-size", size_in_bytes: 100 },
        ],
      })
    },
  })
  const report = await client.readReport(42)
  assert.deepEqual(downloads, [1, 2])
  assert.deepEqual(report.junitDocs, [junit])
  assert.equal(report.playwrightJson, null)
  assert.equal(report.bundle, null)
  assert.ok(
    report.warnings.includes("Report processing time budget exceeded; remaining evidence omitted")
  )
})
