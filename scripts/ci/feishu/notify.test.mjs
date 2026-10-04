import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepare, deliver } from "./notify.mjs"
import { stateKey, normalizeRun } from "./policy.mjs"

const source = (overrides = {}) => ({
  id: 42,
  run_attempt: 1,
  run_number: 42,
  workflow_id: 7,
  name: "CI/CD Pipeline",
  path: ".github/workflows/ci.yml",
  head_branch: "dev",
  head_sha: "a".repeat(40),
  head_repository: { full_name: "owner/repo" },
  repository: { full_name: "owner/repo" },
  event: "push",
  status: "completed",
  conclusion: "failure",
  html_url: "https://github.com/owner/repo/actions/runs/42",
  run_started_at: "2026-10-03T01:00:00Z",
  updated_at: "2026-10-03T01:03:00Z",
  actor: { login: "someone" },
  ...overrides,
})
const now = () => Date.parse("2026-10-03T02:00:00Z")
function fixture(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "feishu-ci-"))
  const env = {
    FEISHU_OUTPUT_DIR: dir,
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_RUN_ID: "100",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    SOURCE_RUN_ID: "42",
    DRY_RUN: "true",
    ...overrides,
  }
  const client = {
    getRun: async () => source(),
    getJobs: async () => [],
    listRuns: async () => [],
    listRecentRuns: async () => [],
    listArtifacts: async () => [],
    readReport: async () => ({ junitDocs: [], playwrightJson: null, bundle: null, warnings: [] }),
    getRelease: async () => null,
    getPullRequestsForCommit: async () => [],
  }
  return { env, client, now, dir }
}

test("manual dry-run needs no webhook and produces a card without sending or claiming", async () => {
  const f = fixture()
  const result = await prepare(f)
  assert.equal(result.outcome, "dry-run")
  assert.equal(result.prepared, false)
  const card = JSON.parse(readFileSync(join(f.dir, "preview.json"), "utf8"))
  assert.match(JSON.stringify(card), /failure/)
  assert.match(readFileSync(join(f.dir, "preview.html"), "utf8"), /Local layout preview/)
})

test("disabled automatic notifications perform no GitHub calls", async () => {
  const f = fixture({ DRY_RUN: "false", GITHUB_EVENT_NAME: "workflow_run" })
  f.client.getRun = async () => {
    throw new Error("should not fetch")
  }
  assert.equal((await prepare(f)).reason, "disabled")
})

test("live plan contains no credentials and delivery refuses to POST without durable claim", async () => {
  const f = fixture({
    DRY_RUN: "false",
    FEISHU_ENABLED: "true",
    FEISHU_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/secret-token",
    FEISHU_SIGNING_SECRET: "signing-secret",
  })
  assert.equal((await prepare(f)).prepared, true)
  const plan = readFileSync(join(f.dir, "plan.json"), "utf8")
  assert.doesNotMatch(plan, /secret-token|signing-secret/)
  await assert.rejects(
    deliver({
      ...f,
      send: async () => {
        throw new Error("must not send")
      },
    }),
    /claim/
  )
})

test("source runs from a different base repository are rejected", async () => {
  const f = fixture()
  f.client.getRun = async () => source({ repository: { full_name: "other/repo" } })
  await assert.rejects(prepare(f), /repository/)
})

test("old manual source runs cannot outlive receipt retention", async () => {
  const f = fixture()
  f.client.getRun = async () => source({ run_started_at: "2026-01-01T00:00:00Z" })
  await assert.rejects(prepare(f), /retention/)
})

test("successful rerun recovers from a failed earlier attempt of the same run", async () => {
  const f = fixture()
  f.client.getRun = async (_id, attempt) =>
    attempt === 1 ? source() : source({ run_attempt: 2, conclusion: "success" })
  const result = await prepare(f)
  assert.equal(result.reason, "recovered")
  assert.equal(result.wouldSend, true)
})

test("an old completed CI result is suppressed after a newer source run finishes", async () => {
  const f = fixture()
  f.client.listRecentRuns = async () => [source({ id: 43, run_number: 43, conclusion: "success" })]
  const result = await prepare(f)
  assert.equal(result.reason, "superseded-run")
  assert.equal(result.wouldSend, false)
})

test("manual digest summarizes every source workflow category for the previous UTC day", async () => {
  const f = fixture({ SOURCE_RUN_ID: "" })
  f.client.listRuns = async ({ created }) => {
    assert.equal(created, "2026-10-02T00:00:00Z..2026-10-02T23:59:59Z")
    return [
      source(),
      source({ name: "Release", path: ".github/workflows/release.yml", conclusion: "success" }),
      source({ path: ".github/workflows/feishu-notify.yml" }),
    ]
  }
  const result = await prepare(f)
  assert.equal(result.reason, "daily-digest")
  assert.match(readFileSync(join(f.dir, "preview.json"), "utf8"), /2 runs · 1 failed/)
})

test("a failed optional report cannot hide source failure", async () => {
  const f = fixture()
  f.client.readReport = async () => {
    throw new Error("bad source artifact")
  }
  const result = await prepare(f)
  assert.deepEqual(result.warnings, ["report-unavailable"])
  assert.equal(result.wouldSend, true)
  assert.match(
    readFileSync(join(f.dir, "preview.json"), "utf8"),
    /source workflow result is preserved/
  )
})

function liveFixture() {
  const f = fixture({
    DRY_RUN: "false",
    FEISHU_ENABLED: "true",
    FEISHU_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/secret-token",
    FEISHU_SIGNING_SECRET: "signing-secret",
  })
  f.artifacts = []
  f.env.CLAIM_ARTIFACT_ID = "10"
  f.client.getRun = async (id) =>
    Number(id) === 100
      ? source({ id: 100, path: ".github/workflows/feishu-notify.yml", event: "workflow_dispatch" })
      : source()
  f.client.listArtifacts = async ({ name, runId }) =>
    f.artifacts.filter(
      (a) => (!name || a.name === name) && (!runId || a.workflow_run.id === Number(runId))
    )
  f.claim = (key) => {
    const artifact = {
      id: 10,
      name: `${key}-claim`,
      created_at: "2026-10-03T02:00:00Z",
      expires_at: "2027-01-02T02:00:00Z",
      expired: false,
      workflow_run: { id: 100 },
    }
    f.artifacts.push(artifact)
    return artifact
  }
  return f
}

test("persisted claim permits one send and an accepted receipt suppresses replay", async () => {
  const f = liveFixture()
  const prepared = await prepare(f)
  f.claim(prepared.key)
  const receipt = await deliver({
    ...f,
    send: async ({ url, secret, body }) => {
      assert.equal(url, f.env.FEISHU_WEBHOOK_URL)
      assert.equal(secret, "signing-secret")
      assert.equal(body.msg_type, "interactive")
      return { outcome: "accepted", attempts: 1, code: 0 }
    },
  })
  assert.equal(receipt.claimId, 10)
  assert.equal(receipt.outcome, "accepted")
  f.artifacts.push({
    id: 11,
    name: `${prepared.key}-accepted`,
    expired: false,
    workflow_run: { id: 100 },
  })
  assert.equal((await prepare(f)).reason, "already-accepted")
  assert.doesNotMatch(
    readFileSync(join(f.dir, "receipt.json"), "utf8"),
    /secret-token|signing-secret/
  )
})

test("unknown delivery blocks automatic replay and requires the explicit manual override", async () => {
  const f = liveFixture()
  const first = await prepare(f)
  f.claim(first.key)
  const receipt = await deliver({
    ...f,
    send: async () => ({ outcome: "delivery-unknown", attempts: 1 }),
  })
  assert.equal(receipt.outcome, "delivery-unknown")
  await assert.rejects(prepare(f), /previous-delivery-unknown/)
  f.env.RESEND_UNKNOWN = "true"
  assert.equal((await prepare(f)).prepared, true)
})

test("destination rotation invalidates a prepared plan without posting", async () => {
  const f = liveFixture()
  const first = await prepare(f)
  f.claim(first.key)
  f.env.FEISHU_WEBHOOK_URL += "-rotated"
  await assert.rejects(
    deliver({ ...f, send: async () => assert.fail("must not send") }),
    /destination-changed/
  )
})

test("a newer attempt starting after preparation suppresses the stale send", async () => {
  const f = liveFixture()
  const first = await prepare(f)
  f.claim(first.key)
  const getRun = f.client.getRun
  f.client.getRun = async (id) =>
    id === 42 ? source({ run_attempt: 2, status: "in_progress" }) : getRun(id)
  const result = await deliver({ ...f, send: async () => assert.fail("must not send") })
  assert.equal(result.outcome, "superseded")
  assert.equal(result.attempts, 0)
})

test("same failure is suppressed only with accepted evidence from the same destination", async () => {
  const f = liveFixture()
  const previous = source({ id: 41, run_number: 41 })
  f.client.listRecentRuns = async () => [previous]
  const key = stateKey(normalizeRun(previous, []), f.env.FEISHU_WEBHOOK_URL)
  f.artifacts.push({ id: 9, name: `${key}-accepted`, expired: false, workflow_run: { id: 100 } })
  assert.equal((await prepare(f)).reason, "unchanged-failure")
  f.env.FEISHU_WEBHOOK_URL += "-new-destination"
  assert.equal((await prepare(f)).prepared, true)
})

test("a history outage preserves new failures but a current-ledger outage fails closed", async () => {
  const f = liveFixture()
  f.client.listRecentRuns = async () => {
    throw new Error("unavailable")
  }
  const result = await prepare(f)
  assert.equal(result.prepared, true)
  assert.ok(result.warnings.includes("history-unavailable"))
  f.client.listArtifacts = async () => {
    throw new Error("no receipt evidence")
  }
  await assert.rejects(prepare(f))
})

test("short effective artifact retention refuses the POST and leaves safe retry evidence", async () => {
  const f = liveFixture()
  const first = await prepare(f)
  f.claim(first.key).expires_at = "2026-10-17T02:00:00Z"
  const receipt = await deliver({ ...f, send: async () => assert.fail("must not send") })
  assert.equal(receipt.outcome, "rejected")
  assert.equal(receipt.reason, "insufficient-artifact-retention")
  assert.equal(receipt.attempts, 0)
})

test("all mode keeps completed historical runs visible without history noise filtering", async () => {
  const f = fixture({ FEISHU_MODE: "all" })
  f.client.listRecentRuns = async () => assert.fail("all does not need history")
  f.client.getRun = async () => source({ conclusion: "cancelled" })
  const result = await prepare(f)
  assert.equal(result.reason, "all-results")
  assert.equal(result.wouldSend, true)
})

test("claim identity must match this upload before posting", async () => {
  const f = liveFixture()
  const first = await prepare(f)
  f.claim(first.key)
  f.env.CLAIM_ARTIFACT_ID = "20"
  await assert.rejects(
    deliver({ ...f, send: async () => assert.fail("must not send") }),
    /claim-id/
  )
})

test("failure card exposes failed steps, associated PR and immutable commit context", async () => {
  const f = fixture()
  f.client.getRun = async () =>
    source({
      event: "pull_request",
      pull_requests: [],
      head_commit: { message: "Fix renderer\nDetails" },
    })
  f.client.getJobs = async () => [
    {
      name: "Unit tests",
      conclusion: "failure",
      html_url: "https://github.com/owner/repo/actions/runs/42/job/88",
      steps: [{ number: 4, name: "Run Jest", conclusion: "failure" }],
    },
  ]
  f.client.getPullRequestsForCommit = async () => [
    {
      number: 9,
      title: "Wrong PR",
      base: { repo: { full_name: "other/repo" } },
      head: { sha: "a".repeat(40) },
    },
    {
      number: 10,
      title: "Fix <at id=all>renderer</at>",
      draft: true,
      base: { repo: { full_name: "owner/repo" } },
      head: { sha: "a".repeat(40) },
    },
  ]
  await prepare(f)
  const card = readFileSync(join(f.dir, "preview.json"), "utf8")
  assert.match(card, /#step:4:1/)
  assert.match(card, /Run Jest/)
  assert.match(card, /pull\/10/)
  assert.doesNotMatch(card, /Wrong PR/)
  assert.match(card, /Draft/)
  assert.match(card, /commit\/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/)
})

test("artifact shortcuts include only retained current-attempt artifacts with size and expiry", async () => {
  const f = fixture()
  const artifact = {
    id: 71,
    name: "playwright-report",
    size_in_bytes: 2048,
    created_at: "2026-10-03T01:02:00Z",
    expires_at: "2026-10-10T01:02:00Z",
    expired: false,
    workflow_run: { id: 42 },
  }
  f.client.listArtifacts = async () => [
    artifact,
    { ...artifact, id: 72, name: "expired-report", expired: true },
    { ...artifact, id: 73, name: "prior-attempt", created_at: "2026-10-02T01:00:00Z" },
    { ...artifact, id: 74, name: "different-run", workflow_run: { id: 43 } },
  ]
  await prepare(f)
  const card = readFileSync(join(f.dir, "preview.json"), "utf8")
  assert.match(card, /artifacts\/71/)
  assert.match(card, /2.0 KiB/)
  assert.match(card, /2026-10-10/)
  assert.doesNotMatch(card, /expired-report|prior-attempt|different-run/)
})

test("release card keeps direct installer downloads even when pipeline fails", async () => {
  const f = fixture()
  f.client.getRun = async () =>
    source({ name: "Release", path: ".github/workflows/release.yml", head_branch: "v1.2.0" })
  f.client.getRelease = async () => ({
    html_url: "https://github.com/owner/repo/releases/tag/v1.2.0",
    tag_name: "v1.2.0",
    draft: false,
    prerelease: true,
    body: "Highlights\nNew editor",
    assets: [
      {
        name: "Cognia.dmg",
        size: 1048576,
        browser_download_url: "https://github.com/owner/repo/releases/download/v1.2.0/Cognia.dmg",
      },
    ],
  })
  await prepare(f)
  const card = readFileSync(join(f.dir, "preview.json"), "utf8")
  assert.match(card, /releases\/download\/v1.2.0\/Cognia.dmg/)
  assert.match(card, /1.0 MiB/)
  assert.match(card, /already be public/)
  assert.match(card, /prerelease/)
})

test("test metrics show artifact-scoped failures and flaky first-pass evidence", async () => {
  const f = fixture()
  f.client.readReport = async () => ({
    warnings: [],
    junitDocs: [
      '<testsuite><testcase name="fast" time="1"/><testcase name="broken" time="2"><failure message="no"/></testcase></testsuite>',
    ],
    playwrightJson: {
      suites: [
        {
          specs: [
            {
              title: "flaky browser",
              tests: [
                {
                  status: "flaky",
                  results: [
                    { status: "failed", duration: 100 },
                    { status: "passed", duration: 50 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  })
  await prepare(f)
  const card = readFileSync(join(f.dir, "preview.json"), "utf8")
  assert.match(card, /1 passed \/ 1 failed/)
  assert.match(card, /First-pass: 0%/)
  assert.match(card, /broken/)
  assert.match(card, /flaky browser/)
})

test("daily digest uses conclusive runs as success-rate denominator and lists pending separately", async () => {
  const f = fixture({ SOURCE_RUN_ID: "" })
  f.client.listRuns = async () => [
    source(),
    source({ id: 43, conclusion: "success" }),
    source({ id: 44, conclusion: "cancelled" }),
    source({ id: 45, conclusion: null, status: "in_progress" }),
  ]
  await prepare(f)
  const card = readFileSync(join(f.dir, "preview.json"), "utf8")
  assert.match(card, /50.0%/)
  assert.match(card, /2 conclusive/)
  assert.match(card, /1 pending/)
  assert.match(card, /1 cancelled/)
})

test("empty daily digest reports unavailable success rate instead of zero failures as success", async () => {
  const f = fixture({ SOURCE_RUN_ID: "" })
  await prepare(f)
  const card = readFileSync(join(f.dir, "preview.json"), "utf8")
  assert.match(card, /No workflow runs/)
  assert.match(card, /N\/A/)
})

test("optional PR and artifact outages preserve failure cards without leaking upstream errors", async () => {
  const f = fixture()
  f.client.getPullRequestsForCommit = async () => {
    throw new Error("private-token-upstream")
  }
  f.client.listArtifacts = async () => {
    throw new Error("private-token-upstream")
  }
  const result = await prepare(f)
  assert.equal(result.wouldSend, true)
  assert.deepEqual(result.warnings, ["pr-metadata-unavailable", "artifact-metadata-unavailable"])
  assert.doesNotMatch(readFileSync(join(f.dir, "preview.html"), "utf8"), /private-token-upstream/)
  assert.doesNotMatch(
    readFileSync(join(f.dir, "diagnostic.json"), "utf8"),
    /private-token-upstream/
  )
})
