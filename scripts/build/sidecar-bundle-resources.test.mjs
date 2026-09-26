import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test, { after } from "node:test"
import { fileURLToPath } from "node:url"

import {
  SIDECAR_ENTRY_POINTS,
  analyzeSidecarClosure,
  computeSidecarClosure,
  findUncoveredResources,
  findUnstagedRequiredEntries,
  packageNameOf,
  requiredSidecarEntries,
  resourceMatcher,
  runtimeReferences,
} from "./sidecar-bundle-resources.mjs"

const root = fileURLToPath(new URL("../..", import.meta.url))

async function bundleResources() {
  const conf = JSON.parse(await readFile(path.join(root, "src-tauri/tauri.conf.json"), "utf8"))
  return conf.bundle.resources
}

/** A throwaway git work tree (files untracked but not ignored count as known). */
function fixtureRepo(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "sidecar-closure-"))
  execFileSync("git", ["init", "-q"], { cwd: dir })
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), content)
  }
  return dir
}
const fixtures = []
after(() => fixtures.forEach((dir) => rmSync(dir, { recursive: true, force: true })))
const fixture = (files) => {
  const dir = fixtureRepo(files)
  fixtures.push(dir)
  return dir
}

test("the real sidecar graph has no unresolved, undeclared or unknown references", () => {
  const { problems } = analyzeSidecarClosure(root)
  assert.deepEqual(problems, [], `the packaged sidecar would break:\n  ${problems.join("\n  ")}`)
})

test("stages every module the sidecar entry points import", async () => {
  // A packaged sidecar that is missing one import is not a degraded sidecar: it
  // exits with ERR_MODULE_NOT_FOUND, and `packaged_sidecar_dir` still prefers it
  // over the complete checkout because its required entries are present.
  const uncovered = findUncoveredResources(root, await bundleResources())

  assert.deepEqual(
    uncovered,
    [],
    `bundle.resources does not stage these imported files:\n  ${uncovered.join("\n  ")}`
  )
})

test("stages every entry the Rust host requires of a packaged sidecar", async () => {
  const entries = requiredSidecarEntries(root)
  assert.ok(entries.includes("agent-host.mjs") && entries.includes("node_modules"), "parsed the Rust list")
  assert.deepEqual(findUnstagedRequiredEntries(root, await bundleResources()), [])
})

test("walks past the entry points into their transitive dependencies", () => {
  const closure = computeSidecarClosure(root)

  for (const entry of SIDECAR_ENTRY_POINTS) assert.ok(closure.has(entry), `missing ${entry}`)
  // Regression pin: these three were imported by the entry points yet absent
  // from bundle.resources, which is what broke the staged sidecar.
  assert.ok(closure.has("sidecar/src/platform/net/install-fetch-interceptor.ts"))
  assert.ok(closure.has("sidecar/src/platform/host-rpc.ts"))
  assert.ok(closure.has("sidecar/src/platform/telemetry/index.ts"))
  // The closure must leave sidecar/ when an import does.
  assert.ok(closure.has("lib/settings/builtin-tools-data.json"))
  // A file spawned by URL (the run_code sandbox child) is a runtime file too.
  assert.ok(closure.has("sidecar/src/tools/builtin/run-code/sandbox-child.ts"))
})

test("keeps an entry point in the closure even when the build has not written it", () => {
  // `sidecar/cognia-mcp.mjs` is a gitignored esbuild bundle that only
  // `prebuild` produces, so it is missing in a fresh clone. Skipping an absent
  // entry point would make the guard report full coverage of a list that had
  // stopped staging it — failing open, which is the one thing it must not do.
  const closure = computeSidecarClosure(root, ["sidecar/does-not-exist-yet.mjs"])
  assert.ok(closure.has("sidecar/does-not-exist-yet.mjs"))

  const uncovered = findUncoveredResources(root, [], ["sidecar/does-not-exist-yet.mjs"])
  assert.deepEqual(uncovered, ["sidecar/does-not-exist-yet.mjs"])
})

test("fails closed: an unresolved relative import is a finding, not a type-only import", () => {
  const dir = fixture({
    "sidecar/package.json": JSON.stringify({ dependencies: {} }),
    "sidecar/entry.mjs": 'import "./gone.mjs"\n',
  })
  const { problems } = analyzeSidecarClosure(dir, ["sidecar/entry.mjs"])
  assert.equal(problems.length, 1)
  assert.match(problems[0], /sidecar\/entry\.mjs imports sidecar\/gone\.mjs, which is neither a known file/)
})

test("follows .ts modules, skips type-only imports, and flags unknown file types", () => {
  const dir = fixture({
    "sidecar/package.json": JSON.stringify({ dependencies: {} }),
    "sidecar/entry.mjs": 'import { a } from "./src/a.ts"\nimport "./style.css"\n',
    "sidecar/src/a.ts":
      'import type { T } from "./types.ts"\nexport type { U } from "./gone-types.ts"\nimport data from "./data.json" with { type: "json" }\nexport const a: T = data\n',
    "sidecar/src/types.ts": "export type T = unknown\n",
    "sidecar/src/data.json": "{}\n",
    "sidecar/style.css": "",
  })
  const { files, problems } = analyzeSidecarClosure(dir, ["sidecar/entry.mjs"])
  assert.deepEqual([...files].sort(), ["sidecar/entry.mjs", "sidecar/src/a.ts", "sidecar/src/data.json", "sidecar/style.css"])
  assert.equal(problems.length, 1)
  assert.match(problems[0], /style\.css, whose extension \.css is not a runtime file type/)
})

test("flags a bare import the owning package.json does not declare", () => {
  // The unbash regression: declared only at the repo root, so it resolved in a
  // checkout (Node walks up to the root node_modules) and not in the bundle.
  const dir = fixture({
    "sidecar/package.json": JSON.stringify({ dependencies: { zod: "^4" }, optionalDependencies: { "node-pty": "^1" } }),
    "sidecar/entry.mjs":
      'import { z } from "zod"\nimport pty from "node-pty"\nimport fs from "node:fs"\nimport path from "path"\nimport { parse } from "unbash"\nconst rg = await import("@vscode/ripgrep")\n',
  })
  const { problems } = analyzeSidecarClosure(dir, ["sidecar/entry.mjs"])
  assert.equal(problems.length, 1)
  assert.match(problems[0], /imports unbash, but sidecar\/package\.json does not declare unbash/)
})

test("a declared build output may be absent; a file named by URL is walked when present", () => {
  const dir = fixture({
    "sidecar/package.json": JSON.stringify({ dependencies: {} }),
    "sidecar/entry.mjs":
      'import "./webclone/dist/index.js"\nconst child = new URL("./child.mjs", import.meta.url)\nconst other = new URL("../elsewhere.mjs", import.meta.url)\n',
    "sidecar/child.mjs": 'import "./child-dep.mjs"\n',
    "sidecar/child-dep.mjs": "",
  })
  const { files, problems } = analyzeSidecarClosure(dir, ["sidecar/entry.mjs"])
  assert.deepEqual(problems, [])
  assert.ok(files.has("sidecar/webclone/dist/index.js"))
  assert.ok(files.has("sidecar/child-dep.mjs"))
  assert.ok(!files.has("elsewhere.mjs"), "a URL target that does not exist in this layout is not required")
})

test("runtimeReferences separates runtime imports from erased ones", () => {
  const refs = runtimeReferences(
    "x.ts",
    [
      'import a from "./a.ts"',
      'import type { B } from "./b.ts"',
      'import { type C } from "./c.ts"',
      'export * from "./d.ts"',
      'export type { E } from "./e.ts"',
      'const f = await import("./f.ts")',
      'type G = import("./g.ts").G',
      'const h = new URL("./h.mjs", import.meta.url)',
      'const i = new URL("https://example.com")',
    ].join("\n")
  )
  assert.deepEqual(refs.imports, ["./a.ts", "./c.ts", "./d.ts", "./f.ts"])
  assert.deepEqual(refs.fileUrls, ["./h.mjs"])
})

test("packageNameOf keeps the scope and drops the subpath", () => {
  assert.equal(packageNameOf("@modelcontextprotocol/sdk/client/index.js"), "@modelcontextprotocol/sdk")
  assert.equal(packageNameOf("zod/v4"), "zod")
})

test("findUnstagedRequiredEntries flags a Rust entry no resource stages", () => {
  const unstaged = findUnstagedRequiredEntries(root, ["../sidecar/agent-host.mjs", "../sidecar/node_modules/**/*"])
  assert.ok(unstaged.some((line) => line.startsWith("sidecar/dispatch is required")))
  assert.ok(!unstaged.some((line) => line.startsWith("sidecar/agent-host.mjs")))
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
  assert.ok(uncovered.includes("sidecar/src/platform/host-rpc.ts"))
})
