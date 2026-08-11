import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

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
