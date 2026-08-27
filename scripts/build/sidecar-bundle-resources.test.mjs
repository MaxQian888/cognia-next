import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  SIDECAR_ENTRY_POINTS,
  computeSidecarClosure,
  findUncoveredResources,
  resourceMatcher,
} from "./sidecar-bundle-resources.mjs"

const root = fileURLToPath(new URL("../..", import.meta.url))

async function bundleResources() {
  const conf = JSON.parse(await readFile(path.join(root, "src-tauri/tauri.conf.json"), "utf8"))
  return conf.bundle.resources
}

test("stages every module the sidecar entry points import", async () => {
  // A packaged sidecar that is missing one import is not a degraded sidecar: it
  // exits with ERR_MODULE_NOT_FOUND, and `packaged_sidecar_dir` still prefers it
  // over the complete checkout because `agent-host.mjs` is present.
  const uncovered = findUncoveredResources(root, await bundleResources())

  assert.deepEqual(
    uncovered,
    [],
    `bundle.resources does not stage these imported files:\n  ${uncovered.join("\n  ")}`
  )
})

test("walks past the entry points into their transitive dependencies", async () => {
  const closure = computeSidecarClosure(root)

  for (const entry of SIDECAR_ENTRY_POINTS) assert.ok(closure.has(entry), `missing ${entry}`)
  // Regression pin: these three were imported by the entry points yet absent
  // from bundle.resources, which is what broke the staged sidecar.
  assert.ok(closure.has("sidecar/fetch-interceptor.mjs"))
  assert.ok(closure.has("sidecar/host-rpc.mjs"))
  assert.ok(closure.has("sidecar/telemetry.mjs"))
  // The closure must leave sidecar/ when an import does.
  assert.ok(closure.has("lib/settings/builtin-tools-data.json"))
})

test("keeps an entry point in the closure even when the build has not written it", () => {
  // `sidecar/cognia-mcp.mjs` and `sidecar/a2ui-mcp.mjs` are gitignored esbuild
  // bundles that only `prebuild` produces, so they are missing in a fresh clone
  // and mid-rewrite while `build-mcp-sidecar.test.mjs` runs alongside this one.
  // Skipping an absent entry point would make the guard report full coverage of
  // a list that had stopped staging it — failing open, which is the one thing it
  // must not do.
  const closure = computeSidecarClosure(root, ["sidecar/does-not-exist-yet.mjs"])
  assert.ok(closure.has("sidecar/does-not-exist-yet.mjs"))

  const uncovered = findUncoveredResources(root, [], ["sidecar/does-not-exist-yet.mjs"])
  assert.deepEqual(uncovered, ["sidecar/does-not-exist-yet.mjs"])
})

test("an unresolvable relative import is still dropped as type-only", () => {
  // The other half of the rule: only entry points survive being absent.
  const closure = computeSidecarClosure(root)
  assert.equal([...closure].some((file) => file.endsWith(".d.ts")), false)
})

test("resolves resource entries relative to src-tauri/", () => {
  const exact = resourceMatcher("../sidecar/agent-host.mjs")
  assert.equal(exact("sidecar/agent-host.mjs"), true)
  assert.equal(exact("sidecar/claude-host.mjs"), false)

  const recursive = resourceMatcher("../sidecar/dispatch/**/*")
  assert.equal(recursive("sidecar/dispatch/index.mjs"), true)
  assert.equal(recursive("sidecar/dispatch/nested/deep/x.mjs"), true)
  assert.equal(recursive("sidecar/other/index.mjs"), false)

  // A single `*` stays within one path segment.
  const shallow = resourceMatcher("../runtime/deepseek-harness/*")
  assert.equal(shallow("runtime/deepseek-harness/run.mjs"), true)
  assert.equal(shallow("runtime/deepseek-harness/nested/run.mjs"), false)

  // Entries without `../` are already relative to src-tauri/.
  const local = resourceMatcher("resources/terminal/shell-integration.zsh")
  assert.equal(local("src-tauri/resources/terminal/shell-integration.zsh"), true)
})

test("reports a dependency that no resource entry covers", () => {
  // Drive the failure path with the real graph but a deliberately short list,
  // so the guard is proven to fail rather than only ever seen passing.
  const uncovered = findUncoveredResources(root, ["../sidecar/agent-host.mjs"])

  assert.ok(uncovered.length > 0, "a one-entry list must leave dependencies uncovered")
  assert.ok(uncovered.includes("sidecar/host-rpc.mjs"))
})
