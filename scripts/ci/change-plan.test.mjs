import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  createChangePlan,
  isCargoDependencyChange,
  isPushBaselineValidated,
  readChangePlan,
  validateChangePlan,
} from "./change-plan.mjs"

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "cognia-ci-history-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const source = path.join(directory, "source")
  const checkout = path.join(directory, "checkout")
  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git(directory, "init", "--quiet", "--initial-branch=dev", source)
  git(source, "config", "user.email", "fixture@example.invalid")
  git(source, "config", "user.name", "CI fixture")
  const commit = (name, contents = name) => {
    mkdirSync(path.dirname(path.join(source, name)), { recursive: true })
    writeFileSync(path.join(source, name), contents)
    git(source, "add", ".")
    git(source, "commit", "--quiet", "-m", name)
    return git(source, "rev-parse", "HEAD")
  }
  const base = commit("old name.js")
  const clone = () => {
    git(directory, "clone", "--quiet", "--depth=2", pathToFileURL(source).href, checkout)
    return git(checkout, "rev-parse", "HEAD")
  }
  return { directory, source, checkout, git, commit, base, clone }
}

test("push planning covers every commit and both sides of a rename in shallow history", (t) => {
  const f = fixture(t)
  f.commit("first.js")
  f.commit("middle.js")
  renameSync(path.join(f.source, "old name.js"), path.join(f.source, "new name.js"))
  f.commit("last.js")
  const head = f.clone()
  writeFileSync(path.join(f.checkout, "untracked.js"), "not committed")
  const plan = createChangePlan(
    { eventName: "push", ref: "refs/heads/dev", head, pushBeforeSha: f.base },
    { cwd: f.checkout }
  )
  assert.equal(plan.mode, "incremental")
  assert.equal(plan.base, f.base)
  assert.equal(plan.mergeBase, null)
  assert.deepEqual(plan.changedFiles, [
    "first.js",
    "last.js",
    "middle.js",
    "new name.js",
    "old name.js",
  ])
  assert.deepEqual(plan.deletedFiles, ["old name.js"])
})

test("PR synthetic merge planning excludes changes already present in its base", (t) => {
  const f = fixture(t)
  f.git(f.source, "checkout", "--quiet", "-b", "feature")
  f.commit("feature.js")
  f.git(f.source, "checkout", "--quiet", "dev")
  const prBase = f.commit("base-only.js")
  f.git(f.source, "merge", "--quiet", "--no-ff", "feature", "-m", "synthetic PR merge")
  const head = f.clone()
  const plan = createChangePlan(
    { eventName: "pull_request", head, prBaseSha: prBase },
    { cwd: f.checkout }
  )
  assert.equal(plan.mode, "incremental")
  assert.deepEqual(plan.changedFiles, ["feature.js"])
  assert.equal(plan.diffBase, prBase)
})

test("new refs, missing objects, force pushes, and failed predecessors require full plans", (t) => {
  const f = fixture(t)
  f.commit("changed.js")
  const head = f.clone()
  for (const [overrides, reason] of [
    [{ pushBeforeSha: "0".repeat(40) }, "missing-event-base"],
    [{ pushBeforeSha: "f".repeat(40) }, "unfetchable-event-base"],
    [{ pushForced: true }, "force-push"],
    [{ baselineValidated: false }, "unverified-push-baseline"],
  ]) {
    const plan = createChangePlan(
      { eventName: "push", ref: "refs/heads/dev", head, pushBeforeSha: f.base, ...overrides },
      { cwd: f.checkout }
    )
    assert.equal(plan.mode, "full", reason)
    assert.equal(plan.reason, reason)
    assert.equal(plan.base, head)
  }
})

test("an unavailable PR base falls back to full instead of an empty incremental selection", (t) => {
  const f = fixture(t)
  const head = f.clone()
  const plan = createChangePlan(
    { eventName: "pull_request", head, prBaseSha: "f".repeat(40) },
    { cwd: f.checkout }
  )
  assert.equal(plan.mode, "full")
  assert.equal(plan.reason, "unfetchable-event-base")
})

test("selection policy changes force full validation while preserving the exact diff", (t) => {
  const f = fixture(t)
  f.commit("scripts/ci/change-plan.mjs")
  const head = f.clone()
  const plan = createChangePlan(
    { eventName: "pull_request", head, prBaseSha: f.base },
    { cwd: f.checkout }
  )
  assert.equal(plan.mode, "full")
  assert.equal(plan.reason, "selection-policy-changed")
  assert.deepEqual(plan.changedFiles, ["scripts/ci/change-plan.mjs"])
})

test("scheduled, tagged and default manual invocations retain full validation", (t) => {
  const f = fixture(t)
  const head = f.clone()
  for (const input of [
    { eventName: "schedule" },
    { eventName: "workflow_dispatch" },
    { eventName: "push", ref: "refs/tags/v1.0.0" },
    { eventName: "pull_request", requestedMode: "full" },
  ])
    assert.equal(createChangePlan({ head, ...input }, { cwd: f.checkout }).mode, "full")
  assert.equal(
    createChangePlan(
      { head, eventName: "workflow_dispatch", requestedMode: "incremental" },
      { cwd: f.checkout }
    ).reason,
    "missing-parent"
  )
})

test("the dependency-free CLI writes a verifiable plan from a real shallow checkout", (t) => {
  const f = fixture(t)
  f.commit("changed.js")
  const head = f.clone()
  const output = path.join(f.directory, "artifacts", "changes.json")
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL("./change-plan.mjs", import.meta.url)), "--output", output],
    {
      cwd: f.checkout,
      env: {
        ...process.env,
        EVENT_NAME: "pull_request",
        REQUESTED_MODE: "auto",
        GITHUB_SHA: head,
        PR_BASE_SHA: f.base,
      },
      stdio: "pipe",
    }
  )
  const plan = readChangePlan(output, { cwd: f.checkout })
  assert.deepEqual(plan.changedFiles, ["changed.js"])
  f.git(f.checkout, "checkout", "--quiet", f.base)
  assert.throws(() => readChangePlan(output, { cwd: f.checkout }), /checked-out HEAD/)
  const malformed = JSON.parse(readFileSync(output, "utf8"))
  malformed.deletedFiles = ["not-changed.js"]
  assert.throws(() => validateChangePlan(malformed), /Inconsistent/)
  for (const changedFiles of [["../outside.js"], ["/absolute.js"], ["same.js", "same.js"]]) {
    assert.throws(() => validateChangePlan({ ...plan, changedFiles }), /Invalid/)
  }
  assert.throws(() => validateChangePlan({ ...plan, head: [head] }), /Invalid/)
  assert.throws(
    () => createChangePlan({ head, requestedMode: "oops" }, { cwd: f.checkout }),
    /Invalid requested/
  )
})

test("push catch-up accepts only a successful CI run of the exact predecessor and branch", async () => {
  const env = {
    EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/dev",
    PUSH_BEFORE_SHA: "a".repeat(40),
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_TOKEN: "fixture-token",
  }
  const run = {
    head_sha: env.PUSH_BEFORE_SHA,
    event: "push",
    head_branch: "dev",
    conclusion: "success",
  }
  const response = (runs) => async (url) => {
    assert.equal(new URL(url).searchParams.get("head_sha"), env.PUSH_BEFORE_SHA)
    return { ok: true, json: async () => ({ workflow_runs: runs }) }
  }
  assert.equal(await isPushBaselineValidated(env, response([run])), true)
  let forcedRequests = 0
  assert.equal(
    await isPushBaselineValidated({ ...env, PUSH_FORCED: "true" }, async () => {
      forcedRequests++
      return { ok: true, json: async () => ({ workflow_runs: [run] }) }
    }),
    false
  )
  assert.equal(forcedRequests, 0, "forced pushes already require full validation")
  for (const overrides of [
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { conclusion: null },
    { head_sha: "b".repeat(40) },
    { head_branch: "other" },
    { event: "pull_request" },
  ]) {
    assert.equal(await isPushBaselineValidated(env, response([{ ...run, ...overrides }])), false)
  }
  assert.equal(await isPushBaselineValidated(env, response([])), false)
  assert.equal(await isPushBaselineValidated(env, async () => ({ ok: false })), false)
  assert.equal(
    await isPushBaselineValidated(env, async () => {
      throw new Error("offline")
    }),
    false
  )
  assert.equal(
    await isPushBaselineValidated({ ...env, GITHUB_TOKEN: "" }, () => {
      throw new Error("unexpected request")
    }),
    false
  )
})

test("Cargo dependency selection is nonempty, complete, and fails closed", () => {
  const plan = {
    mode: "incremental",
    changedFiles: ["Cargo.lock", "Cargo.toml", "crates/cognia-cli/Cargo.toml"],
    deletedFiles: [],
  }
  assert.equal(isCargoDependencyChange(plan), true)
  for (const override of [
    { mode: "full" },
    { changedFiles: [] },
    { changedFiles: ["Cargo.lock", "src-tauri/src/lib.rs"] },
    { changedFiles: ["services/diagnostic-server/Cargo.lock"] },
    { changedFiles: ["crates/cognia-cli/build.rs"] },
    { deletedFiles: ["Cargo.toml"] },
  ])
    assert.equal(isCargoDependencyChange({ ...plan, ...override }), false)
})
