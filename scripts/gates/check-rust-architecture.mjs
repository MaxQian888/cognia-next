#!/usr/bin/env node
/**
 * Gate: the Rust workspace keeps its layers (ADR-0196).
 *
 * ADR-0067 cut the Tauri crate `app_lib` from 170k lines to 67k by moving
 * subsystems into `crates/`. Nothing stopped it from growing back, and within
 * ten weeks it was larger than before the split. Meanwhile library crates
 * picked up `tauri`, foundation crates picked up a JavaScript engine, and the
 * headless `cognia-server` ended up linking webkit. This gate is the thing
 * that was missing: it reads the workspace manifests and refuses changes that
 * make any of that worse.
 *
 * ## What it checks
 *
 *   1. Every workspace member has a layer in `rust-architecture.json`.
 *   2. Every internal dependency edge points down the layer stack, or is a
 *      same-layer edge the config allows by name.
 *   3. Forbidden reach: a crate's default-feature closure must not contain the
 *      packages its rule names (foundation crates never reach tauri, wasmtime,
 *      a JS engine…).
 *   4. Tauri-free by default: with default features, no library crate reaches
 *      `tauri` or a `tauri-plugin-*`. Tauri command shells sit behind the
 *      crate's `tauri-host` feature, and only the app turns that on.
 *   5. Only the crates listed as enablers may turn on another crate's
 *      `tauri-host` feature.
 *   6. The app shell (`src-tauri/src`) may only have the top-level modules the
 *      config lists, and its line count stays under a ceiling that each
 *      extraction lowers.
 *
 * Findings 2–5 are ratcheted against `rust-architecture-baseline.json`: the
 * baseline records the violations that existed when the gate landed, a new one
 * fails, and a fixed one must be removed from the baseline so the list only
 * shrinks.
 *
 * ## Why `cargo metadata --no-deps` and not `resolve`
 *
 * `resolve` unifies features across the whole workspace, so every crate would
 * look like it reaches tauri because the app enables `tauri-host`. The gate
 * resolves features itself, one crate at a time, over workspace-internal
 * edges only — the same question `cargo build -p <crate>` answers. Target-
 * specific dependencies count on every target (conservative). `--deep`
 * cross-checks the answer with `cargo tree -i tauri` per crate.
 *
 * Usage:
 *   pnpm audit:rust-architecture                   # check
 *   pnpm audit:rust-architecture:baseline          # after fixing a violation
 *   pnpm audit:rust-architecture:deep              # + cargo tree cross-check
 *   node scripts/gates/check-rust-architecture.mjs --print-tauri-host-features
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join, relative, sep } from "node:path"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
export const CONFIG_FILE = join(REPO_ROOT, "scripts", "gates", "rust-architecture.json")
export const BASELINE_FILE = join(REPO_ROOT, "scripts", "gates", "rust-architecture-baseline.json")

/**
 * Match a package name against a pattern with an optional trailing `*`. Pure.
 *
 * @param {string} name
 * @param {string} pattern
 */
export function matchesPattern(name, pattern) {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern
}

/** @param {string} name */
export function isTauriPackage(name) {
  return name === "tauri" || name.startsWith("tauri-plugin-")
}

/**
 * Index `cargo metadata` output by workspace member. Pure.
 *
 * @param {{ packages: any[], workspace_members: string[] }} metadata
 */
export function indexWorkspace(metadata) {
  const memberIds = new Set(metadata.workspace_members)
  const members = new Map()
  const byDir = new Map()
  for (const pkg of metadata.packages) {
    if (!memberIds.has(pkg.id)) continue
    members.set(pkg.name, pkg)
    byDir.set(normalizeDir(dirname(pkg.manifest_path)), pkg.name)
  }
  return { members, byDir }
}

function normalizeDir(dir) {
  return dir.split(sep).join("/").replace(/\/+$/, "")
}

/**
 * The workspace member a dependency points at, or null when it is external
 * (registry, git, or a path crate outside the workspace).
 */
export function memberOf(ws, dep) {
  if (!dep.path) return null
  return ws.byDir.get(normalizeDir(dep.path)) ?? null
}

/** The key a dependency is known by inside its dependent's feature table. */
function depKey(dep) {
  return dep.rename ?? dep.name
}

/**
 * The dependencies of `pkg` that are active when `features` are enabled, each
 * with the features the edge asks of it. Dev-dependencies never count. Pure.
 *
 * Handles `dep:x`, implicit optional-dependency features, `x/feat` (enables
 * optional `x` and its `feat`) and `x?/feat` (only if `x` is on anyway).
 *
 * @param {any} pkg
 * @param {Iterable<string>} features
 */
export function activeDependencies(pkg, features) {
  const table = pkg.features ?? {}
  const deps = pkg.dependencies.filter((dep) => dep.kind !== "dev")
  const optionalKeys = new Set(deps.filter((dep) => dep.optional).map(depKey))
  const enabled = new Set()
  const activated = new Set()
  const edgeFeatures = new Map()
  const weak = []
  const addEdgeFeature = (key, feature) => {
    if (!edgeFeatures.has(key)) edgeFeatures.set(key, new Set())
    edgeFeatures.get(key).add(feature)
  }
  const stack = [...features]
  while (stack.length > 0) {
    const feature = stack.pop()
    if (enabled.has(feature)) continue
    enabled.add(feature)
    const values = table[feature]
    if (values === undefined) {
      // An optional dependency is its own implicit feature when nothing
      // refers to it with `dep:`.
      if (optionalKeys.has(feature)) activated.add(feature)
      continue
    }
    for (const value of values) {
      if (value.startsWith("dep:")) {
        activated.add(value.slice(4))
      } else if (value.includes("?/")) {
        const [key, sub] = value.split("?/")
        weak.push([key, sub])
      } else if (value.includes("/")) {
        const [key, sub] = value.split("/")
        if (optionalKeys.has(key)) activated.add(key)
        if (table[key] !== undefined) stack.push(key)
        addEdgeFeature(key, sub)
      } else {
        stack.push(value)
      }
    }
  }
  for (const [key, sub] of weak) {
    if (activated.has(key) || !optionalKeys.has(key)) addEdgeFeature(key, sub)
  }
  const active = []
  for (const dep of deps) {
    const key = depKey(dep)
    if (dep.optional && !activated.has(key)) continue
    const requested = new Set(dep.features)
    if (dep.uses_default_features) requested.add("default")
    for (const feature of edgeFeatures.get(key) ?? []) requested.add(feature)
    active.push({ dep, features: requested })
  }
  return active
}

/**
 * Resolve the closure `cargo build -p <root>` would compile with `features`,
 * following workspace-internal edges and unifying features per crate. Pure.
 *
 * @returns {{ internal: Map<string, Set<string>>, external: Map<string, string> }}
 *   `internal`: reached member → enabled features.
 *   `external`: reached external package → the member that pulled it in.
 */
export function resolveClosure(ws, root, features = ["default"]) {
  const internal = new Map()
  const external = new Map()
  const queue = [[root, new Set(features)]]
  while (queue.length > 0) {
    const [name, requested] = queue.shift()
    const current = internal.get(name) ?? new Set()
    const fresh = [...requested].filter((feature) => !current.has(feature))
    if (internal.has(name) && fresh.length === 0) continue
    for (const feature of fresh) current.add(feature)
    internal.set(name, current)
    const pkg = ws.members.get(name)
    if (!pkg) continue
    for (const { dep, features: edge } of activeDependencies(pkg, current)) {
      const member = memberOf(ws, dep)
      if (member) queue.push([member, edge])
      else if (!external.has(dep.name)) external.set(dep.name, name)
    }
  }
  return { internal, external }
}

/** The name of the feature that carries `crate`'s Tauri surface. */
export function hostFeatureOf(config, crate) {
  return config.tauri.hostFeatureOverrides?.[crate] ?? config.tauri.hostFeature
}

/**
 * Every finding the manifests support, as stable string keys. Pure.
 *
 * @returns {{ ratcheted: string[], hard: string[] }}
 *   `ratcheted` findings are compared against the baseline; `hard` ones
 *   (an unassigned crate, an unknown layer) always fail.
 */
export function collectFindings(ws, config) {
  const layerIndex = new Map(config.layers.map((layer, index) => [layer, index]))
  const allowedSame = new Set(config.allowedSameLayer)
  const ratcheted = new Set()
  const hard = []

  for (const name of ws.members.keys()) {
    const layer = config.crates[name]
    if (layer === undefined)
      hard.push(`unassigned-crate: ${name} has no layer in rust-architecture.json`)
    else if (!layerIndex.has(layer)) hard.push(`unknown-layer: ${name} is in "${layer}"`)
  }
  for (const name of Object.keys(config.crates)) {
    if (!ws.members.has(name))
      hard.push(`stale-crate: ${name} is in rust-architecture.json but not a workspace member`)
  }

  const edges = new Set()
  for (const [name, pkg] of ws.members) {
    const from = layerIndex.get(config.crates[name])
    if (from === undefined) continue
    for (const dep of pkg.dependencies) {
      if (dep.kind === "dev") continue
      const target = memberOf(ws, dep)
      if (!target) continue
      const to = layerIndex.get(config.crates[target])
      if (to === undefined) continue
      const edge = `${name} -> ${target}`
      edges.add(edge)
      if (to > from || (to === from && !allowedSame.has(edge))) ratcheted.add(`layer: ${edge}`)

      const hostFeature = hostFeatureOf(config, target)
      const asksHost =
        dep.features.includes(hostFeature) ||
        Object.values(pkg.features ?? {}).some((values) =>
          values.some(
            (value) =>
              value === `${depKey(dep)}/${hostFeature}` ||
              value === `${depKey(dep)}?/${hostFeature}`
          )
        )
      if (asksHost && !config.tauri.enablers.includes(name)) {
        ratcheted.add(`host-enabler: ${name} enables ${target}/${hostFeature}`)
      }
    }
  }
  for (const edge of allowedSame) {
    if (!edges.has(edge))
      hard.push(
        `stale-allowed-edge: "${edge}" is in allowedSameLayer but no such dependency exists`
      )
  }

  for (const name of ws.members.keys()) {
    const layer = config.crates[name]
    const { internal, external } = resolveClosure(ws, name)
    const reached = new Set([
      ...external.keys(),
      ...[...internal.keys()].filter((crate) => crate !== name),
    ])

    if (!config.tauri.allowed.includes(name)) {
      const tauri = [...external.keys()].filter(isTauriPackage).sort()
      if (tauri.length > 0) ratcheted.add(`tauri-default: ${name}`)
    }

    for (const rule of config.forbidden) {
      const applies = rule.from.layer ? rule.from.layer === layer : rule.from.crates.includes(name)
      if (!applies) continue
      for (const target of [...reached].sort()) {
        if (rule.reach.some((pattern) => matchesPattern(target, pattern))) {
          ratcheted.add(`forbidden: ${name} reaches ${target}`)
        }
      }
    }

    const pkg = ws.members.get(name)
    for (const rule of config.directOnly) {
      if (rule.allowed.includes(name)) continue
      if (pkg.dependencies.some((dep) => dep.kind !== "dev" && dep.name === rule.dep)) {
        ratcheted.add(`direct-only: ${name} depends on ${rule.dep}`)
      }
    }
  }

  return { ratcheted: [...ratcheted].sort(), hard }
}

/**
 * The top-level entries of the app shell from a list of tracked file paths.
 * Pure.
 *
 * @param {string[]} trackedFiles  repo-relative paths
 * @param {string} srcDir
 */
export function appShellEntries(trackedFiles, srcDir) {
  const prefix = `${srcDir}/`
  const entries = new Set()
  for (const file of trackedFiles) {
    if (!file.startsWith(prefix)) continue
    entries.add(file.slice(prefix.length).split("/")[0])
  }
  return [...entries].sort()
}

/**
 * Compare the app shell against its allow-list and line ceiling. Pure.
 *
 * @param {{ entries: string[], loc: number }} shell
 * @param {{ modules: string[], maxLoc: number, locSlack: number }} config
 */
export function appShellFindings(shell, config) {
  const allowed = new Set(config.modules)
  const present = new Set(shell.entries)
  const modules = []
  for (const entry of shell.entries) {
    if (!allowed.has(entry)) {
      modules.push(
        `new-app-module: src-tauri/src/${entry} — new Rust code belongs in the lowest-layer crate under crates/ that can own it (ADR-0196); if it truly is app-shell code, add it to appShell.modules`
      )
    }
  }
  for (const entry of config.modules) {
    if (!present.has(entry))
      modules.push(
        `stale-app-module: ${entry} is listed in appShell.modules but no longer exists — remove it`
      )
  }
  const loc = []
  if (shell.loc > config.maxLoc) {
    loc.push(
      `app-shell-loc: src-tauri/src has ${shell.loc} lines, over the ${config.maxLoc} ceiling — move code into crates/ instead`
    )
  } else if (config.maxLoc - shell.loc > config.locSlack) {
    loc.push(
      `app-shell-loc-stale: src-tauri/src has ${shell.loc} lines, ${config.maxLoc - shell.loc} under the ${config.maxLoc} ceiling — lower appShell.maxLoc to ${shell.loc + config.locSlack}`
    )
  }
  return { modules, loc }
}

/**
 * Split current findings into new ones and baseline rows that no longer apply.
 * Pure.
 *
 * @param {string[]} current
 * @param {string[]} baseline
 */
export function diffAgainstBaseline(current, baseline) {
  const now = new Set(current)
  const before = new Set(baseline)
  return {
    added: current.filter((finding) => !before.has(finding)),
    fixed: baseline.filter((finding) => !now.has(finding)),
  }
}

/** Every member's Tauri host feature, as `crate/feature` for `cargo --features`. Pure. */
export function tauriHostFeatureList(ws, config) {
  const list = []
  for (const [name, pkg] of ws.members) {
    if (config.tauri.allowed.includes(name)) continue
    const feature = hostFeatureOf(config, name)
    if (pkg.features && Object.hasOwn(pkg.features, feature)) list.push(`${name}/${feature}`)
  }
  return list.sort()
}

function loadMetadata() {
  const result = spawnSync(
    "cargo",
    ["metadata", "--no-deps", "--format-version", "1", "--offline"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    }
  )
  if (result.status !== 0) {
    throw new Error(`cargo metadata failed:\n${result.stderr}`)
  }
  return JSON.parse(result.stdout)
}

function readAppShell(config) {
  const listed = spawnSync("git", ["ls-files", "-z", "--", config.srcDir], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
  if (listed.status !== 0) throw new Error(`git ls-files failed:\n${listed.stderr}`)
  // `git ls-files` still lists a tracked file whose deletion is not staged yet;
  // a path that is gone from disk is not part of the shell any more.
  const files = listed.stdout
    .split("\0")
    .filter(Boolean)
    .filter((file) => existsSync(join(REPO_ROOT, file)))
  let loc = 0
  for (const file of files) {
    if (!file.endsWith(".rs")) continue
    let text
    try {
      text = readFileSync(join(REPO_ROOT, file), "utf8")
    } catch {
      continue // tracked but deleted in the working tree
    }
    loc += text.split("\n").length - (text.endsWith("\n") ? 1 : 0)
  }
  return { entries: appShellEntries(files, config.srcDir), loc }
}

function deepCheck(ws, config, baselined) {
  const failures = []
  for (const name of ws.members.keys()) {
    if (config.tauri.allowed.includes(name) || baselined.has(`tauri-default: ${name}`)) continue
    const result = spawnSync(
      "cargo",
      ["tree", "-p", name, "-e", "normal,build", "--target", "all", "-i", "tauri", "--locked"],
      { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    )
    const out = `${result.stdout}\n${result.stderr}`
    if (result.status === 0 && out.includes("tauri v")) {
      failures.push(
        `deep: cargo tree says ${name} reaches tauri with default features, but the manifest resolver said it does not`
      )
    }
  }
  return failures
}

function main(argv) {
  const config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"))
  const ws = indexWorkspace(loadMetadata())

  if (argv.includes("--print-tauri-host-features")) {
    process.stdout.write(`${tauriHostFeatureList(ws, config).join(",")}\n`)
    return 0
  }

  const { ratcheted, hard } = collectFindings(ws, config)
  const shell = appShellFindings(readAppShell(config.appShell), config.appShell)

  if (argv.includes("--write-baseline")) {
    const body = {
      $comment:
        "Written by `pnpm audit:rust-architecture:baseline`. Rows are violations that existed when the gate landed; the list may only shrink (ADR-0196).",
      findings: ratcheted,
    }
    writeFileSync(BASELINE_FILE, `${JSON.stringify(body, null, 2)}\n`)
    console.log(
      `rust-architecture: wrote ${ratcheted.length} baseline findings to ${relative(REPO_ROOT, BASELINE_FILE)}`
    )
    return 0
  }

  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8")).findings
  const { added, fixed } = diffAgainstBaseline(ratcheted, baseline)
  const failures = [...hard, ...added.map((finding) => `new ${finding}`), ...shell.modules]
  if (fixed.length > 0) {
    failures.push(
      ...fixed.map(
        (finding) =>
          `fixed ${finding} — remove it from the baseline (pnpm audit:rust-architecture:baseline)`
      )
    )
  }
  if (argv.includes("--deep")) failures.push(...deepCheck(ws, config, new Set(baseline)))

  const locFailures = config.appShell.locBlocking ? shell.loc : []
  const locWarnings = config.appShell.locBlocking ? [] : shell.loc
  failures.push(...locFailures)

  for (const warning of locWarnings)
    console.warn(`⚠ ${warning} (advisory until appShell.locBlocking is on)`)
  if (failures.length > 0) {
    console.error(`✗ rust-architecture: ${failures.length} finding(s)`)
    for (const failure of failures) console.error(`  - ${failure}`)
    return 1
  }
  console.log(
    `✓ rust-architecture: ${ws.members.size} crates layered; ${baseline.length} baselined finding(s) left to fix`
  )
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)))
}
