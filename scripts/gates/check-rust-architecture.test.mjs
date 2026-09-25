/**
 * Coverage for scripts/gates/check-rust-architecture.mjs.
 *
 * Everything that decides a finding is pure, so the tests build small
 * `cargo metadata`-shaped workspaces by hand instead of shelling out to cargo.
 * Two tests read the committed config and baseline to pin their shape.
 *
 * Run with: node --test scripts/gates/check-rust-architecture.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import {
  BASELINE_FILE,
  CONFIG_FILE,
  activeDependencies,
  appShellEntries,
  appShellFindings,
  collectFindings,
  diffAgainstBaseline,
  indexWorkspace,
  isTauriPackage,
  matchesPattern,
  resolveClosure,
  tauriHostFeatureList,
} from "./check-rust-architecture.mjs"

const ROOT = "/repo"

/** A registry dependency. */
const ext = (name, extra = {}) => ({
  name,
  kind: null,
  optional: false,
  uses_default_features: true,
  features: [],
  rename: null,
  path: undefined,
  ...extra,
})

/** A path dependency on another workspace crate. */
const member = (name, extra = {}) => ext(name, { path: `${ROOT}/crates/${name}`, ...extra })

/** A workspace package. */
const pkg = (name, dependencies = [], features = {}) => ({
  name,
  id: `path+file://${ROOT}/crates/${name}#0.1.0`,
  manifest_path: `${ROOT}/crates/${name}/Cargo.toml`,
  dependencies,
  features,
})

const workspace = (...packages) =>
  indexWorkspace({ packages, workspace_members: packages.map((p) => p.id) })

const baseConfig = (crates, extra = {}) => ({
  layers: ["foundation", "platform", "domain", "app"],
  crates,
  allowedSameLayer: [],
  forbidden: [],
  directOnly: [],
  tauri: {
    allowed: ["app"],
    hostFeature: "tauri-host",
    hostFeatureOverrides: {},
    enablers: ["app"],
  },
  ...extra,
})

test("patterns match exactly or by trailing-star prefix", () => {
  assert.ok(matchesPattern("wasmtime", "wasmtime"))
  assert.ok(matchesPattern("wasmtime-wasi", "wasmtime-*"))
  assert.ok(!matchesPattern("wasmtime", "wasmtime-*"))
  assert.ok(!matchesPattern("tauri-build", "tauri"))
  assert.ok(isTauriPackage("tauri"))
  assert.ok(isTauriPackage("tauri-plugin-fs"))
  assert.ok(!isTauriPackage("tauri-build"))
})

test("optional dependencies are off until a feature turns them on", () => {
  const lib = pkg("lib", [ext("tauri", { optional: true }), ext("serde")], {
    default: [],
    "tauri-host": ["dep:tauri"],
  })
  const names = (features) => activeDependencies(lib, features).map(({ dep }) => dep.name)
  assert.deepEqual(names(["default"]), ["serde"])
  assert.deepEqual(names(["default", "tauri-host"]), ["tauri", "serde"])
})

test("an optional dependency is its own implicit feature", () => {
  const lib = pkg("lib", [ext("liteparse", { optional: true })], { default: ["liteparse"] })
  assert.deepEqual(
    activeDependencies(lib, ["default"]).map(({ dep }) => dep.name),
    ["liteparse"]
  )
})

test("dev-dependencies never count", () => {
  const lib = pkg("lib", [ext("tauri", { kind: "dev" })], {})
  assert.deepEqual(activeDependencies(lib, ["default"]), [])
})

test("`x/feat` turns on x and asks it for feat; `x?/feat` only asks", () => {
  const lib = pkg(
    "lib",
    [member("inner", { optional: true }), member("other", { optional: true })],
    { default: ["inner/tauri-host", "other?/tauri-host"] }
  )
  const active = activeDependencies(lib, ["default"])
  assert.deepEqual(
    active.map(({ dep }) => dep.name),
    ["inner"]
  )
  assert.ok(active[0].features.has("tauri-host"))
})

test("default features follow the edge only when the edge keeps them", () => {
  const lib = pkg("lib", [member("inner", { uses_default_features: false })])
  assert.deepEqual([...activeDependencies(lib, ["default"])[0].features], [])
})

test("the closure unifies features per crate across paths", () => {
  const ws = workspace(
    pkg("app", [member("a"), member("b")]),
    pkg("a", [member("shared", { uses_default_features: false })]),
    pkg("b", [member("shared", { uses_default_features: false, features: ["tauri-host"] })]),
    pkg("shared", [ext("tauri", { optional: true })], { default: [], "tauri-host": ["dep:tauri"] })
  )
  const { internal, external } = resolveClosure(ws, "app")
  assert.ok(internal.get("shared").has("tauri-host"))
  assert.equal(external.get("tauri"), "shared")
})

test("a library reaching tauri with default features is a finding", () => {
  const ws = workspace(
    pkg("app", [member("lib", { features: ["tauri-host"] })]),
    pkg("lib", [ext("tauri", { optional: true })], {
      default: ["tauri-host"],
      "tauri-host": ["dep:tauri"],
    })
  )
  const config = baseConfig({ app: "app", lib: "domain" })
  assert.deepEqual(collectFindings(ws, config).ratcheted, ["tauri-default: lib"])

  ws.members.get("lib").features.default = []
  assert.deepEqual(collectFindings(ws, config).ratcheted, [])
})

test("tauri reached through a dependency's default features counts", () => {
  const ws = workspace(
    pkg("state", [member("gateway")]),
    pkg("gateway", [ext("tauri", { optional: true })], {
      default: ["tauri-host"],
      "tauri-host": ["dep:tauri"],
    })
  )
  const config = baseConfig(
    { state: "domain", gateway: "domain" },
    { allowedSameLayer: ["state -> gateway"] }
  )
  assert.deepEqual(collectFindings(ws, config).ratcheted, [
    "tauri-default: gateway",
    "tauri-default: state",
  ])

  ws.members.get("state").dependencies[0].uses_default_features = false
  assert.deepEqual(collectFindings(ws, config).ratcheted, ["tauri-default: gateway"])
})

test("edges must point down the layers unless allowed by name", () => {
  const ws = workspace(
    pkg("net", [member("secrets")]),
    pkg("secrets"),
    pkg("core", [member("git")]),
    pkg("git")
  )
  const config = baseConfig({
    net: "foundation",
    secrets: "foundation",
    core: "foundation",
    git: "domain",
  })
  assert.deepEqual(collectFindings(ws, config).ratcheted, [
    "layer: core -> git",
    "layer: net -> secrets",
  ])

  config.allowedSameLayer = ["net -> secrets"]
  assert.deepEqual(collectFindings(ws, config).ratcheted, ["layer: core -> git"])
})

test("an allowed edge that no longer exists is stale", () => {
  const ws = workspace(pkg("net"), pkg("secrets"))
  const config = baseConfig(
    { net: "foundation", secrets: "foundation" },
    { allowedSameLayer: ["net -> secrets"] }
  )
  assert.match(collectFindings(ws, config).hard[0], /stale-allowed-edge/)
})

test("every member needs a layer and every layered crate must exist", () => {
  const ws = workspace(pkg("orphan"))
  const { hard } = collectFindings(ws, baseConfig({ ghost: "domain" }))
  assert.ok(hard.some((finding) => finding.startsWith("unassigned-crate: orphan")))
  assert.ok(hard.some((finding) => finding.startsWith("stale-crate: ghost")))
})

test("forbidden reach follows the default-feature closure, not just direct deps", () => {
  const ws = workspace(pkg("net", [member("diag")]), pkg("diag", [ext("rquickjs")]))
  const config = baseConfig(
    { net: "foundation", diag: "foundation" },
    {
      allowedSameLayer: ["net -> diag"],
      forbidden: [{ from: { layer: "foundation" }, reach: ["rquickjs"], reason: "test" }],
    }
  )
  assert.deepEqual(collectFindings(ws, config).ratcheted, [
    "forbidden: diag reaches rquickjs",
    "forbidden: net reaches rquickjs",
  ])
})

test("forbidden reach can name workspace crates too", () => {
  const ws = workspace(pkg("sandboxd", [member("net")]), pkg("net"))
  const config = baseConfig(
    { sandboxd: "platform", net: "foundation" },
    { forbidden: [{ from: { crates: ["sandboxd"] }, reach: ["net"], reason: "test" }] }
  )
  assert.deepEqual(collectFindings(ws, config).ratcheted, ["forbidden: sandboxd reaches net"])
})

test("direct-only dependencies are allowed only in the named crates", () => {
  const ws = workspace(pkg("secrets", [ext("keyring")]), pkg("tts", [ext("keyring")]))
  const config = baseConfig(
    { secrets: "foundation", tts: "domain" },
    { directOnly: [{ dep: "keyring", allowed: ["secrets"], reason: "test" }] }
  )
  assert.deepEqual(collectFindings(ws, config).ratcheted, ["direct-only: tts depends on keyring"])
})

test("only the listed enablers may turn on a crate's tauri-host", () => {
  const ws = workspace(
    pkg("app", [member("lib", { features: ["tauri-host"] })]),
    pkg("server", [member("lib")], { default: ["lib/tauri-host"] }),
    pkg("lib", [], { "tauri-host": [] })
  )
  const config = baseConfig({ app: "app", server: "app", lib: "domain" })
  assert.deepEqual(collectFindings(ws, config).ratcheted, [
    "host-enabler: server enables lib/tauri-host",
  ])
})

test("a crate may name its host feature differently", () => {
  const ws = workspace(
    pkg("cli", [member("obs", { features: ["desktop-host"] })]),
    pkg("obs", [], { "desktop-host": [] })
  )
  const config = baseConfig({ cli: "app", obs: "domain" })
  config.tauri.hostFeatureOverrides = { obs: "desktop-host" }
  assert.deepEqual(collectFindings(ws, config).ratcheted, [
    "host-enabler: cli enables obs/desktop-host",
  ])
  assert.deepEqual(tauriHostFeatureList(ws, config), ["obs/desktop-host"])
})

test("app shell entries are the first path segment under the source dir", () => {
  assert.deepEqual(
    appShellEntries(
      [
        "src-tauri/src/lib.rs",
        "src-tauri/src/tray/mod.rs",
        "src-tauri/src/tray/dto.rs",
        "src-tauri/build.rs",
      ],
      "src-tauri/src"
    ),
    ["lib.rs", "tray"]
  )
})

test("app shell: an unlisted module and a stale listing both fail", () => {
  const { modules } = appShellFindings(
    { entries: ["lib.rs", "newthing"], loc: 100 },
    { modules: ["lib.rs", "gone"], maxLoc: 200, locSlack: 1000 }
  )
  assert.equal(modules.length, 2)
  assert.match(modules[0], /^new-app-module: src-tauri\/src\/newthing/)
  assert.match(modules[1], /^stale-app-module: gone/)
})

test("app shell line ceiling: over fails, far under asks to lower it", () => {
  const config = { modules: [], maxLoc: 1000, locSlack: 100 }
  assert.match(appShellFindings({ entries: [], loc: 1001 }, config).loc[0], /^app-shell-loc: /)
  assert.deepEqual(appShellFindings({ entries: [], loc: 950 }, config).loc, [])
  assert.match(
    appShellFindings({ entries: [], loc: 800 }, config).loc[0],
    /lower appShell.maxLoc to 900/
  )
})

test("the baseline ratchet reports new findings and fixed rows", () => {
  assert.deepEqual(diffAgainstBaseline(["a", "c"], ["a", "b"]), { added: ["c"], fixed: ["b"] })
})

test("the committed config layers its crates in known layers", () => {
  const config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"))
  const layers = new Set(config.layers)
  for (const [crate, layer] of Object.entries(config.crates)) {
    assert.ok(layers.has(layer), `${crate} is in unknown layer ${layer}`)
  }
  assert.deepEqual(config.tauri.enablers, ["cognia-next"])
  assert.equal(new Set(config.appShell.modules).size, config.appShell.modules.length)
})

test("the committed baseline is a sorted list of known finding kinds", () => {
  const { findings } = JSON.parse(readFileSync(BASELINE_FILE, "utf8"))
  assert.deepEqual(findings, [...findings].sort())
  for (const finding of findings) {
    assert.match(finding, /^(layer|tauri-default|forbidden|direct-only|host-enabler): /)
  }
})
