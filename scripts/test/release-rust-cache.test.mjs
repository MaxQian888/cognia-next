import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { parse } from "yaml"

const workflow = (name) =>
  parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8"))
const rustCache = (job) => job.steps.find((step) => /^Swatinem\/rust-cache@/.test(step.uses ?? ""))

test("tagged Agent hosts restore the native release cache produced on the default branch", () => {
  const release = workflow("release").jobs["publish-agent-hosts"]
  const nightly = workflow("nightly").jobs["agent-host-rust-cache"]
  assert.ok(nightly, "tag-only caches cannot serve later release tags")
  assert.equal(
    nightly.if,
    "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)"
  )
  assert.equal(nightly["timeout-minutes"], 45)
  assert.deepEqual(nightly.permissions, { contents: "read" })
  assert.deepEqual(
    nightly.strategy.matrix.include,
    release.strategy.matrix.include.map(({ runner, target }) => ({ runner, target }))
  )
  assert.equal(nightly["runs-on"], release["runs-on"])
  assert.ok(workflow("nightly").on.schedule.length > 0)
  assert.ok(Object.hasOwn(workflow("nightly").on, "workflow_dispatch"))
  assert.ok(!Object.hasOwn(workflow("nightly").on, "pull_request"))

  for (const job of [nightly, release]) {
    const cache = rustCache(job)
    assert.ok(cache)
    assert.equal(
      cache.with["shared-key"],
      "agent-host-release-v1-${{ runner.os }}-${{ runner.arch }}-${{ matrix.target }}"
    )
    assert.equal(cache.with.workspaces, ". -> target")
    assert.equal(cache.with["cache-bin"], false)
    assert.equal(cache.with["cache-on-failure"], false)
    assert.equal(cache.with["cache-workspace-crates"], false)
    assert.equal(cache["continue-on-error"], true, "cache availability must not block a cold build")
    const setup = job.steps.findIndex((step) => step.run === "rustup show active-toolchain")
    assert.ok(
      setup >= 0 && setup < job.steps.indexOf(cache),
      "rust-cache hashes the repository-pinned compiler"
    )
  }
  assert.equal(rustCache(release).with["save-if"], false)
  assert.equal(
    rustCache(nightly).with["save-if"],
    "${{ github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}"
  )
})

test("warming builds the release helper bins and cache hits never bypass Cargo or release smoke", () => {
  const nightly = workflow("nightly").jobs["agent-host-rust-cache"]
  assert.ok(nightly)
  const build = nightly.steps.find((step) => step.name === "Build release native helpers")
  assert.ok(build)
  assert.equal(build.if, undefined)
  assert.equal(build.shell, "bash", "every failed Cargo command must fail on Windows too")
  assert.ok(nightly.steps.indexOf(build) > nightly.steps.indexOf(rustCache(nightly)))
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
  for (const script of [
    "cli:external-host:build",
    "cli:sandbox-exec:build",
    "cli:worker-workspace:build",
  ]) {
    assert.ok(
      build.run.includes(pkg.scripts[script].replace("cargo build ", "cargo build --locked ")),
      script
    )
    assert.ok(pkg.scripts["cli:native-hosts:build"].includes(script))
  }
  assert.match(pkg.scripts["precli:build:binary"], /cli:release:prepare/)
  assert.match(pkg.scripts["cli:release:prepare"], /cli:native-hosts:build/)
  const release = workflow("release").jobs["publish-agent-hosts"]
  const bundle = release.steps.find((step) => step.run?.startsWith("pnpm cli:build:binary"))
  const smoke = release.steps.find((step) => step.run?.startsWith("pnpm cli:smoke:bun"))
  assert.ok(bundle && smoke)
  assert.equal(bundle.if, undefined)
  assert.equal(smoke.if, undefined)
  assert.ok(release.steps.indexOf(bundle) > release.steps.indexOf(rustCache(release)))
  assert.ok(release.steps.indexOf(smoke) > release.steps.indexOf(bundle))
})
