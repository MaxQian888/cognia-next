import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { main, selectReportArtifacts } from "./select-artifacts.mjs"

test("current reports select JUnit shards and report data; baselines select only comparison data", () => {
  const names = [
    "jest-shard-1",
    "jest-shard-64",
    "playwright-json",
    "coverage-report",
    "bundle-size",
    "jest-runtime-prerequisites",
    "jest-cli-bundle-abc",
    "jest-test-plan",
    "e2e-static-export",
    "playwright-report",
    "jest-shard-invalid",
  ]
  const artifacts = names.map((name, index) => ({ id: index + 1, name, expired: false }))
  assert.deepEqual(
    selectReportArtifacts(artifacts, "current").map((item) => item.id),
    [1, 2, 3, 4, 5]
  )
  assert.deepEqual(
    selectReportArtifacts(artifacts, "baseline").map((item) => item.id),
    [3, 4, 5]
  )
  assert.deepEqual(selectReportArtifacts([], "current"), [])
  assert.deepEqual(selectReportArtifacts(artifacts.slice(5), "baseline"), [])
})

function outputFixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "report-artifact-selection-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return {
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_TOKEN: "fixture-token",
    GITHUB_OUTPUT: path.join(directory, "outputs"),
    REPORT_ARTIFACT_MANIFEST: path.join(directory, "selection.json"),
  }
}

test("the CLI enumerates all pages before publishing exact IDs for download", async (t) => {
  const env = outputFixture(t)
  const pages = []
  await main(["--scope", "current", "--run-id", "42"], env, async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer fixture-token")
    const request = new URL(url)
    assert.equal(request.pathname, "/repos/owner/repo/actions/runs/42/artifacts")
    assert.equal(request.searchParams.get("per_page"), "100")
    const page = Number(request.searchParams.get("page"))
    pages.push(page)
    const artifacts =
      page === 1
        ? Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            name: `ignored-${index}`,
            expired: false,
          }))
        : [{ id: 101, name: "coverage-report", expired: false }]
    return Response.json({ total_count: 101, artifacts })
  })
  assert.deepEqual(pages, [1, 2])
  assert.equal(
    readFileSync(env.GITHUB_OUTPUT, "utf8"),
    "artifact-ids=101\ncount=1\nsingle-name=coverage-report\n"
  )
})

test("an optional absent category publishes an empty selection only after successful enumeration", async (t) => {
  const env = outputFixture(t)
  await main(["--scope", "baseline", "--run-id", "42"], env, async () =>
    Response.json({
      total_count: 1,
      artifacts: [{ id: 1, name: "jest-shard-1", expired: false }],
    })
  )
  assert.equal(readFileSync(env.GITHUB_OUTPUT, "utf8"), "artifact-ids=\ncount=0\nsingle-name=\n")
})

test("download verification catches partial ID downloads and preserves singleton artifact directories", async (t) => {
  const env = outputFixture(t)
  const artifacts = [
    { id: 1, name: "playwright-json", expired: false },
    { id: 2, name: "coverage-report", expired: false },
  ]
  await main(["--scope", "current", "--run-id", "42"], env, async () =>
    Response.json({ total_count: 2, artifacts })
  )
  assert.equal(readFileSync(env.GITHUB_OUTPUT, "utf8"), "artifact-ids=1,2\ncount=2\nsingle-name=\n")
  const directory = path.join(path.dirname(env.GITHUB_OUTPUT), "artifacts")
  mkdirSync(path.join(directory, "playwright-json"), { recursive: true })
  writeFileSync(path.join(directory, "playwright-json/report.json"), "{}")
  const verify = () => main(["--scope", "current", "--verify", "--directory", directory], env)
  await assert.rejects(verify(), /coverage-report/)
  mkdirSync(path.join(directory, "coverage-report"))
  await assert.rejects(verify(), /coverage-report/)
  writeFileSync(path.join(directory, "coverage-report/coverage-final.json"), "{}")
  await verify()
})

for (const status of [401, 403, 404, 500]) {
  test(`API ${status} is a failure, never an optional missing-artifact result`, async (t) => {
    const env = outputFixture(t)
    await assert.rejects(
      main(
        ["--scope", "baseline", "--run-id", "42"],
        env,
        async () => new Response("failure", { status })
      ),
      new RegExp(`GitHub API request failed \\(${status}\\)`)
    )
    assert.equal(existsSync(env.GITHUB_OUTPUT), false)
  })
}

test("network failures and malformed API payloads do not publish a successful selection", async (t) => {
  const env = outputFixture(t)
  for (const request of [
    async () => {
      throw new Error("network down")
    },
    async () => new Response("invalid JSON"),
    async () => Response.json({ artifacts: null }),
  ]) {
    await assert.rejects(main(["--scope", "current", "--run-id", "42"], env, request))
    assert.equal(existsSync(env.GITHUB_OUTPUT), false)
  }
})

test("invalid scopes and unusable selected artifacts fail instead of narrowing silently", () => {
  assert.throws(() => selectReportArtifacts([], "typo"), /scope/)
  assert.throws(
    () => selectReportArtifacts([{ id: 1, name: "coverage-report", expired: true }], "baseline"),
    /expired/
  )
  assert.throws(
    () =>
      selectReportArtifacts(
        [{ id: "1\ncount=0", name: "coverage-report", expired: false }],
        "current"
      ),
    /identifier/
  )
  assert.throws(() => selectReportArtifacts([{}], "current"), /metadata/)
  assert.deepEqual(
    selectReportArtifacts([{ id: 1, name: "unused", expired: true }], "baseline"),
    []
  )
})
