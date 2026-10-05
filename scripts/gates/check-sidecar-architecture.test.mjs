import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import {
  BASELINE_FILE,
  CONFIG_FILE,
  analyze,
  classify,
  cycleEdges,
  diffAgainstBaseline,
  isomorphicViolations,
  loadInput,
  moduleReferences,
  resolveRelative,
  referencesPackage,
  vendorChains,
} from "./check-sidecar-architecture.mjs"

const realConfig = JSON.parse(readFileSync(CONFIG_FILE, "utf8"))

/** A small config with the real layer table and fixture-sized lists. */
const config = {
  ...realConfig,
  launchers: ["sidecar/agent-host.mjs", "sidecar/tool/cli.mjs"],
  selfContained: ["sidecar/tool/"],
  isomorphic: ["sidecar/src/providers/protocol.ts"],
  public: ["sidecar/src/providers/protocol.ts"],
  externalData: ["lib/data.json"],
  generated: [],
}

/** Run the analysis over an in-memory tree. */
function run(files, { external = {}, overrides = {} } = {}) {
  const all = new Set([
    ...Object.keys(files),
    ...Object.keys(external),
    "lib/data.json",
    "lib/other.json",
  ])
  return analyze({
    sidecarFiles: new Map(Object.entries(files)),
    externalFiles: new Map(Object.entries(external)),
    exists: (rel) => all.has(rel),
    config: { ...config, ...overrides },
  })
}

test("a src file may import its own layer and the layers below it", () => {
  const { findings } = run({
    "sidecar/src/shared/errors.ts": "export const x = 1\n",
    "sidecar/src/platform/env.ts": 'import { x } from "../shared/errors.ts"\nexport const y = x\n',
    "sidecar/src/tools/kernel/define.ts":
      'import { y } from "../../platform/env.ts"\nimport { z } from "./result.ts"\nexport const d = y + z\n',
    "sidecar/src/tools/kernel/result.ts": "export const z = 1\n",
  })
  assert.deepEqual(findings, [])
})

test("an upward import is a layer finding, type-only or not", () => {
  const { findings } = run({
    "sidecar/src/shared/errors.ts":
      'import type { T } from "../host/router.ts"\nexport const x: T = 1\n',
    "sidecar/src/host/router.ts": "export type T = number\n",
  })
  assert.deepEqual(findings, [
    "layer: sidecar/src/shared/errors.ts (shared) imports sidecar/src/host/router.ts (host)",
  ])
})

test("within-layer rules: categories stay apart, and so do the two rails", () => {
  const { findings } = run({
    "sidecar/src/tools/builtin/git/status.ts":
      'import "../../kernel/define.ts"\nimport "../../state/tasks.ts"\nimport "./run.ts"\nimport "../process/list.ts"\n',
    "sidecar/src/tools/builtin/git/run.ts": "",
    "sidecar/src/tools/builtin/process/list.ts": "",
    "sidecar/src/tools/kernel/define.ts": "",
    "sidecar/src/tools/state/tasks.ts": "",
    "sidecar/src/runtimes/ai-sdk/index.ts":
      'import "../claude-agent-sdk/options.ts"\nimport "../common/round-trips.ts"\n',
    "sidecar/src/runtimes/claude-agent-sdk/options.ts": "",
    "sidecar/src/runtimes/common/round-trips.ts": "",
  })
  assert.equal(findings.length, 2)
  assert.match(
    findings[0],
    /^within-layer: sidecar\/src\/runtimes\/ai-sdk\/index\.ts imports .*claude-agent-sdk/
  )
  assert.match(
    findings[1],
    /^within-layer: sidecar\/src\/tools\/builtin\/git\/status\.ts imports .*process\/list\.ts/
  )
})

test("src never imports legacy code; legacy may import src", () => {
  const { findings } = run({
    "sidecar/src/policy/plan-mode.ts": 'import "../../dispatch/doom-loop.mjs"\n',
    "sidecar/dispatch/doom-loop.mjs": "",
    "sidecar/lsp/resolver.mjs": 'import "../src/policy/plan-mode.ts"\n',
  })
  assert.deepEqual(findings, [
    "legacy-import: sidecar/src/policy/plan-mode.ts imports not-yet-moved sidecar/dispatch/doom-loop.mjs",
  ])
})

test("production code may not import a launcher, a test, or test-support; tests may", () => {
  const { findings } = run({
    "sidecar/dispatch/a.mjs":
      'import "../agent-host.mjs"\nimport "./a.test.mjs"\nimport "../test-support/harness.ts"\n',
    "sidecar/dispatch/a.test.mjs":
      'import "../agent-host.mjs"\nimport "../test-support/harness.ts"\n',
    "sidecar/agent-host.mjs": "",
    "sidecar/test-support/harness.ts": "",
  })
  assert.deepEqual(findings, [
    "launcher-import: sidecar/dispatch/a.mjs imports the process entry sidecar/agent-host.mjs",
    "test-import: sidecar/dispatch/a.mjs imports sidecar/dispatch/a.test.mjs",
    "test-import: sidecar/dispatch/a.mjs imports sidecar/test-support/harness.ts",
  ])
})

test("relative specifiers spell an extension, and leave the sidecar only for declared data", () => {
  const { findings } = run({
    "sidecar/src/shared/a.ts":
      'import "./b"\nimport data from "../../../lib/data.json" with { type: "json" }\nimport other from "../../../lib/other.json" with { type: "json" }\n',
    "sidecar/src/shared/b.ts": "",
  })
  assert.deepEqual(findings, [
    "exit: sidecar/src/shared/a.ts imports lib/other.json, outside the sidecar",
    'extension: sidecar/src/shared/a.ts imports "./b" without a runtime file extension',
  ])
})

test("self-contained trees and the rest of the sidecar never import each other", () => {
  const { findings } = run({
    "sidecar/tool/cli.mjs": 'import "./shared.mjs"\n',
    "sidecar/tool/shared.mjs": 'import "../src/shared/errors.ts"\n',
    "sidecar/src/shared/errors.ts": 'import "../../tool/shared.mjs"\n',
  })
  assert.deepEqual(findings.filter((f) => f.startsWith("self-contained")).length, 2)
  assert.ok(
    !findings.some((f) => f.includes("tool/cli.mjs imports")),
    "a launcher inside the tree is part of it"
  )
})

test("isomorphic modules use no Node built-ins, packages or import.meta", () => {
  assert.deepEqual(
    isomorphicViolations(
      "p.ts",
      'import type { X } from "zod"\nimport { a } from "./a.ts"\nimport fs from "node:fs"\nimport { z } from "zod"\nconst u = import.meta.url\n'
    ),
    ["import.meta", "node built-in node:fs", "package zod"]
  )
  assert.deepEqual(
    isomorphicViolations("p.ts", "// never touch `import.meta` here\nexport const x = 1\n"),
    []
  )
  const { findings } = run({ "sidecar/src/providers/protocol.ts": 'import os from "node:os"\n' })
  assert.deepEqual(findings, [
    "isomorphic: sidecar/src/providers/protocol.ts uses node built-in node:os",
  ])
})

test("code outside the sidecar may import only public modules or launchers", () => {
  const { findings } = run(
    {
      "sidecar/src/providers/protocol.ts": "",
      "sidecar/src/host/router.ts": "",
      "sidecar/agent-host.mjs": "",
    },
    {
      external: {
        "lib/ok.ts": 'import { a } from "@/sidecar/src/providers/protocol.ts"\n',
        "cli/src/role.ts": 'await import("../../sidecar/agent-host.mjs")\n',
        "lib/bad.test.ts": 'jest.mock("../sidecar/src/host/router.ts")\n',
      },
    }
  )
  assert.deepEqual(findings, [
    "outside: lib/bad.test.ts imports sidecar/src/host/router.ts, which is not in the public list",
  ])
})

test("directory cycles are reported edge by edge", () => {
  assert.deepEqual(
    cycleEdges([
      ["a", "b"],
      ["b", "a"],
      ["b", "c"],
      ["c", "d"],
      ["d", "c"],
      ["d", "e"],
    ]),
    ["a -> b", "b -> a", "c -> d", "d -> c"]
  )
  const { findings } = run({
    "sidecar/dispatch/a.mjs": 'import "../builtin-tools/b.mjs"\n',
    "sidecar/builtin-tools/b.mjs": 'const x = await import("../dispatch/a.mjs")\n',
  })
  assert.deepEqual(findings, [
    "cycle: sidecar/builtin-tools -> sidecar/dispatch",
    "cycle: sidecar/dispatch -> sidecar/builtin-tools",
  ])
})

test("with legacy .mjs switched off, only launchers may stay .mjs", () => {
  const { findings } = run(
    {
      "sidecar/agent-host.mjs": "",
      "sidecar/dispatch/a.mjs": "",
      "sidecar/dispatch/a.test.mjs": "",
    },
    { overrides: { legacyMjsAllowed: false } }
  )
  assert.deepEqual(findings, ["mjs: sidecar/dispatch/a.mjs is .mjs but not a launcher"])
})

test("a file under src/ in no declared layer, and a stale config entry, are reported", () => {
  const { findings, hard } = run(
    { "sidecar/src/misc/x.ts": "" },
    { overrides: { public: ["sidecar/src/providers/gone.ts"] } }
  )
  assert.deepEqual(findings, [
    "unmapped: sidecar/src/misc/x.ts is under sidecar/src/ but in no declared layer",
  ])
  assert.ok(hard.some((line) => line.includes("public names sidecar/src/providers/gone.ts")))
})

test("vendor isolation: a static import anywhere in an entry's closure is a finding", () => {
  const vendorIsolation = [
    { package: "vendor-sdk", entries: ["sidecar/src/runtimes/rail/engine.ts"], why: "fixture" },
  ]
  const clean = run(
    {
      "sidecar/src/runtimes/rail/engine.ts":
        'import { run } from "./run.ts"\nexport const engine = run\n',
      "sidecar/src/runtimes/rail/run.ts": [
        'import type { Options } from "vendor-sdk"',
        'export const run = async (options: Options) => (await import("vendor-sdk/core")).go(options)',
        "",
      ].join("\n"),
    },
    { overrides: { vendorIsolation } }
  )
  assert.deepEqual(clean.findings, [], "type-only and dynamic imports do not load the package")

  const leaky = run(
    {
      "sidecar/src/runtimes/rail/engine.ts":
        'import { run } from "./run.ts"\nexport const engine = run\n',
      "sidecar/src/runtimes/rail/run.ts":
        'import { helper } from "../../tools/kernel/helper.ts"\nexport const run = helper\n',
      "sidecar/src/tools/kernel/helper.ts":
        'import { tool } from "vendor-sdk"\nexport const helper = tool\n',
    },
    { overrides: { vendorIsolation } }
  )
  assert.deepEqual(leaky.findings, [
    "vendor: sidecar/src/runtimes/rail/engine.ts reaches vendor-sdk at runtime: sidecar/src/runtimes/rail/engine.ts -> sidecar/src/runtimes/rail/run.ts -> sidecar/src/tools/kernel/helper.ts -> vendor-sdk",
  ])

  const missing = run({}, { overrides: { vendorIsolation } })
  assert.deepEqual(
    missing.hard.filter((problem) => problem.includes("vendorIsolation")),
    ["config vendorIsolation names sidecar/src/runtimes/rail/engine.ts, which does not exist"]
  )
})

test("vendor isolation: allowedIn confines every reference, type-only included", () => {
  const vendorIsolation = [
    {
      package: "vendor-sdk",
      entries: ["sidecar/src/runtimes/rail/engine.ts"],
      allowedIn: ["sidecar/src/runtimes/vendor/"],
      why: "fixture",
    },
  ]
  const { findings } = run(
    {
      "sidecar/src/runtimes/rail/engine.ts": "export const engine = 1\n",
      "sidecar/src/runtimes/vendor/run.ts":
        'import { go } from "vendor-sdk"\nexport const run = go\n',
      "sidecar/src/shared/wire/inbound.ts": [
        'import type { Options } from "vendor-sdk/types"',
        "export type Mode = Options['mode']",
        "",
      ].join("\n"),
      "sidecar/src/tools/kernel/lazy.ts": 'export const load = () => import("vendor-sdk")\n',
    },
    { overrides: { vendorIsolation } }
  )
  assert.deepEqual(findings, [
    "vendor: sidecar/src/shared/wire/inbound.ts references vendor-sdk outside its allowed modules",
    "vendor: sidecar/src/tools/kernel/lazy.ts references vendor-sdk outside its allowed modules",
  ])
})

test("vendorChains reports one chain per importing module, subpaths included", () => {
  const sources = new Map([
    ["a.ts", 'import "./b.ts"\nimport "./c.ts"\n'],
    ["b.ts", 'export { x } from "pkg/sub"\n'],
    ["c.ts", 'import { y } from "pkg"\nimport { z } from "pkg-other"\n'],
  ])
  assert.deepEqual(
    vendorChains("a.ts", "pkg", sources, (file) => sources.has(file)),
    ["a.ts -> b.ts -> pkg/sub", "a.ts -> c.ts -> pkg"]
  )
})

test("referencesPackage sees static, type-only and dynamic references to a package or subpath", () => {
  assert.equal(referencesPackage("a.ts", 'import type { X } from "pkg/types"\n', "pkg"), true)
  assert.equal(referencesPackage("a.ts", 'const m = await import("pkg")\n', "pkg"), true)
  assert.equal(referencesPackage("a.ts", 'export { y } from "pkg"\n', "pkg"), true)
  assert.equal(referencesPackage("a.ts", 'import { z } from "pkg-other"\n// pkg\n', "pkg"), false)
})

test("helpers: classification, resolution, references", () => {
  assert.deepEqual(classify("sidecar/src/tools/x.ts", config), { kind: "src", layer: "tools" })
  assert.deepEqual(classify("sidecar/webclone/dist/runner.js", config), { kind: "nested" })
  assert.deepEqual(classify("sidecar/tool/cli.mjs", config), {
    kind: "launcher",
    root: "sidecar/tool/",
  })
  const exists = (rel) => rel === "sidecar/a/b.ts"
  assert.equal(resolveRelative("sidecar/a/c.ts", "./b", exists), "sidecar/a/b.ts")
  assert.equal(resolveRelative("sidecar/a/c.ts", "./b.ts", exists), "sidecar/a/b.ts")
  assert.deepEqual(
    moduleReferences("x.test.ts", 'jest.requireActual("./a")\ntype T = import("./b.ts").T\n'),
    [
      { specifier: "./a", typeOnly: false },
      { specifier: "./b.ts", typeOnly: true },
    ]
  )
  assert.deepEqual(diffAgainstBaseline(["a", "b"], ["b", "c"]), { added: ["a"], fixed: ["c"] })
})

test("live: the committed tree matches its baseline and the config names real files", () => {
  const { findings, hard } = analyze(loadInput(realConfig))
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8")).findings
  assert.deepEqual(hard, [])
  assert.deepEqual(diffAgainstBaseline(findings, baseline), { added: [], fixed: [] })
})
