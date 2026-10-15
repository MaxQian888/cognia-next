import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { parse } from "yaml"

const root = path.resolve(import.meta.dirname, "../..")
const workflow = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8")
const changesets = JSON.parse(fs.readFileSync(path.join(root, ".changeset/config.json"), "utf8"))

test("publishes and certifies every native Agent SDK host before the client package", () => {
  for (const target of ["darwin-arm64", "linux-x64", "win32-x64"]) {
    assert.match(workflow, new RegExp(`target: ${target}`))
    assert.ok(workflow.includes("agent:host:package -- ${{ matrix.target }}"))
    assert.ok(workflow.includes("agent:host:smoke -- ${{ matrix.target }}"))
  }
  assert.match(
    workflow,
    /publish-agent-sdk:[\s\S]*needs: publish-agent-hosts[\s\S]*agent:sdk:smoke[\s\S]*packages\/agent pack:test[\s\S]*packages\/agent publish/
  )
})

test("keeps the SDK and platform hosts in one fixed Changesets version group", () => {
  assert.deepEqual(changesets.fixed, [
    [
      "@cognia/agent",
      "@cognia/agent-host-darwin-arm64",
      "@cognia/agent-host-linux-x64",
      "@cognia/agent-host-win32-x64",
    ],
  ])
})

test("release jobs are idempotent when an exact npm version already exists", () => {
  assert.match(workflow, /npm view "@cognia\/\$\{\{ matrix\.package \}\}@\$VERSION" version/)
  assert.match(workflow, /npm view "@cognia\/agent@\$VERSION" version/)
  assert.match(workflow, /if: steps\.release\.outputs\.publish == 'true'/)
})

test("SDK publication consumes a verified same-run host and requires both smoke paths", () => {
  const jobs = parse(workflow).jobs
  const producer = jobs["publish-agent-hosts"].steps
  const packageStep = producer.find(
    (step) => step.run === "pnpm agent:host:package -- ${{ matrix.target }}"
  )
  assert.equal(packageStep.if, undefined, "a rerun must prepare artifacts even for published hosts")
  const upload = producer.find((step) => step.name === "Publish SDK host prerequisites")
  assert.ok(upload, "the SDK job cannot inherit another runner's files")
  assert.equal(upload.if, "matrix.target == 'linux-x64'")
  assert.equal(upload.with["if-no-files-found"], "error")
  assert.equal(upload.with["compression-level"], 0)
  assert.ok(producer.indexOf(packageStep) < producer.indexOf(upload))
  assert.ok(
    producer.findIndex((step) => step.run?.startsWith("pnpm agent:host:smoke")) <
      producer.indexOf(upload)
  )

  const consumer = jobs["publish-agent-sdk"]
  assert.equal(consumer.permissions.actions, "read")
  const steps = consumer.steps
  const locate = steps.findIndex((step) => step.id === "host-artifact")
  const download = steps.findIndex((step) => step.name === "Download SDK host prerequisites")
  const restore = steps.findIndex(
    (step) => step.name === "Verify and restore SDK host prerequisites"
  )
  const fallback = steps.findIndex((step) => step.name === "Build missing SDK host prerequisites")
  const prepare = steps.findIndex((step) => step.name === "Prepare Node RPC smoke prerequisites")
  const smoke = steps.findIndex((step) => step.run === "pnpm agent:sdk:smoke")
  const pack = steps.findIndex(
    (step) => step.run === "pnpm --dir packages/agent pack:test --require-host"
  )
  const publish = steps.findIndex(
    (step) => step.run === "pnpm --dir packages/agent publish --no-git-checks"
  )
  assert.ok(locate >= 0 && locate < download && download < restore && restore < prepare)
  assert.ok(
    fallback > restore && fallback < prepare && prepare < smoke && smoke < pack && pack < publish
  )
  assert.match(steps[download].if, /steps\.host-artifact\.outputs\.id != ''/)
  assert.match(steps[fallback].if, /steps\.host-artifact\.outputs\.id == ''/)
  assert.equal(steps[download].with["digest-mismatch"], "error")
  assert.match(steps[fallback].run, /cli:build:binary/)
  assert.match(steps[fallback].run, /cli:smoke:bun/)
  assert.match(steps[fallback].run, /agent:host:package/)
  assert.match(steps[prepare].run, /sidecar:webclone:build/)
  assert.match(steps[prepare].run, /build-browser-builtin-plugins\.mjs/)
  assert.match(steps[prepare].run, /release-agent-host\.mjs env/)
  for (const index of [locate, download, restore, fallback, prepare, smoke, pack, publish]) {
    assert.equal(steps[index]["continue-on-error"], undefined)
    assert.ok(!steps[index].run?.includes("|| true"))
  }
})

test("release handoff regressions run in the existing CI script gate", () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  for (const file of [
    "scripts/ci/release-agent-host.test.mjs",
    "scripts/ci/agent-sdk-release.test.mjs",
  ]) {
    assert.ok(scripts["scripts:test:ci"].includes(file), `${file} must run in CI`)
  }
})
