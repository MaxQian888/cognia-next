#!/usr/bin/env node
/**
 * Deterministic refresh + verification of the vendored pi-latex-workbench
 * snapshot under `plugins/pi-latex-workbench/vendor/`.
 *
 *   # rewrite vendor/ from an upstream checkout at a ref (commit, tag, branch)
 *   node plugins/pi-latex-workbench/scripts/sync-vendor.mjs --upstream <dir> --ref <ref>
 *
 *   # verify vendor/ against the recorded commit (offline: per-file git blob ids
 *   # in vendor-lock.json; with --upstream also against the commit's own tree)
 *   node plugins/pi-latex-workbench/scripts/sync-vendor.mjs --check [--upstream <dir>]
 *
 * The snapshot is taken with `git archive <commit> -- <paths>` — never from a
 * working tree — so local, uncommitted or gitignored upstream state (the
 * provisioned 2.9 GB toolchain, render helper, `.latexwb/` state) can never
 * leak in. The selected path set is a pure function of the commit's tree
 * (`selectVendorPaths`), and every derived file (vendor-lock.json, VENDOR.md,
 * plugin.json `bundle_include`) is rendered from it, so two syncs of the same
 * commit are byte-identical.
 *
 * vendor/ itself is left byte-for-byte equal to the upstream archive: Cognia
 * glue lives in pi/, skills/ and src/ beside it, never inside it.
 */

import { createHash } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const UPSTREAM_URL = "https://github.com/Arxtect/pi-latex-workbench"
export const LOCK_FILE = "vendor-lock.json"
export const VENDOR_DIR = "vendor"
export const VENDOR_DOC = "VENDOR.md"

/** Single files copied verbatim from the upstream root. */
export const VENDOR_EXACT_PATHS = Object.freeze([
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "README.md",
  "README.zh-CN.md",
  "runtime/host-policy.json",
  "runtime/toolchain-lock.json",
  "docs/INSTALL.md",
  "docs/RUNBOOK.md",
  "docs/PI-SESSION.md",
  "docs/UNSUPPORTED.md",
  // Loaded at module-init by packages/contracts/src/validators.ts
  // (`new URL("../schemas/contracts.schema.json", import.meta.url)`): without
  // it every CLI command and the Pi extension fail before doing anything.
  "packages/contracts/schemas/contracts.schema.json",
])

/**
 * Path rules, in the order VENDOR.md documents them. `test` is the matcher;
 * `rule` is the human-readable spelling.
 */
export const VENDOR_PATTERNS = Object.freeze([
  { rule: "packages/*/package.json", test: (p) => /^packages\/[^/]+\/package\.json$/.test(p) },
  { rule: "packages/*/tsconfig.json", test: (p) => /^packages\/[^/]+\/tsconfig\.json$/.test(p) },
  { rule: "packages/*/src/**", test: (p) => /^packages\/[^/]+\/src\/.+/.test(p) },
  {
    rule: "packages/adapter-pi/extensions/**",
    test: (p) => p.startsWith("packages/adapter-pi/extensions/"),
  },
  { rule: "resources/**", test: (p) => p.startsWith("resources/") },
  { rule: "migrations/**", test: (p) => p.startsWith("migrations/") },
  { rule: "runtime/presets/**", test: (p) => p.startsWith("runtime/presets/") },
])

/**
 * Never vendored even if a rule above matched: upstream tests, fixtures,
 * recorded agent runs, design inputs, dev scripts, and the gitignored
 * provisioned runtime (toolchain bundle, render helper).
 */
export const VENDOR_EXCLUDED_SEGMENTS = Object.freeze([
  "test",
  "tests",
  "fixtures",
  "results",
  "design",
  "scripts",
])
export const VENDOR_EXCLUDED_PREFIXES = Object.freeze(["runtime/toolchain/", "runtime/render/"])

/**
 * Local-only directories inside vendor/ a sync must never delete: dependencies
 * installed by the Pi package `prepare` step, the provisioned toolchain and
 * render helper, and CLI state if someone ran the CLI with vendor/ as cwd.
 * They are gitignored and absent from the archive.
 */
export const PRESERVED_VENDOR_DIRS = Object.freeze([
  "node_modules",
  "runtime/toolchain",
  "runtime/render",
  ".latexwb",
  ".latexwb-materialize",
])

/** Plugin-root files the install ZIP carries besides vendor/, skills/ and pi/. */
export const BUNDLE_DOCS = Object.freeze(["README.md", "README.zh-CN.md", VENDOR_DOC, LOCK_FILE])
/** Plugin-root directories whose non-test files ship in the install ZIP. */
export const BUNDLE_DIRS = Object.freeze(["pi", "skills"])

/** Is `path` (posix, upstream-root relative) part of the vendored snapshot? Pure. */
export function isVendorPath(path) {
  if (VENDOR_EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) return false
  if (path.split("/").some((segment) => VENDOR_EXCLUDED_SEGMENTS.includes(segment))) return false
  if (VENDOR_EXACT_PATHS.includes(path)) return true
  return VENDOR_PATTERNS.some(({ test }) => test(path))
}

/**
 * Select the vendored subset of an upstream tree listing. Throws when a
 * required exact path is missing — an upstream layout change must be a loud
 * refresh failure, not a silently thinner snapshot. Pure.
 *
 * @param {readonly string[]} paths every file path of the upstream commit
 * @returns {string[]} sorted selection
 */
export function selectVendorPaths(paths) {
  const selected = [...new Set(paths.filter(isVendorPath))].sort()
  const missing = VENDOR_EXACT_PATHS.filter((path) => !selected.includes(path))
  if (missing.length > 0) {
    throw new Error(`upstream tree lacks required vendor paths: ${missing.join(", ")}`)
  }
  return selected
}

/**
 * Git's blob object id (SHA-1 of `blob <len>\0<bytes>`), as `git hash-object` prints. Pure.
 *
 * @param {Buffer | string} bytes
 * @returns {string}
 */
export function gitBlobSha1(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  return createHash("sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex")
}

function toPosix(path) {
  return path.split(sep).join("/")
}

function isPreserved(relPath) {
  return PRESERVED_VENDOR_DIRS.some((dir) => relPath === dir || relPath.startsWith(`${dir}/`))
}

/** Every file under `root` (posix, root-relative), skipping preserved local dirs. */
export function listVendorFiles(root) {
  const out = []
  if (!existsSync(root)) return out
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const rel = toPosix(relative(root, full))
      if (isPreserved(rel)) continue
      if (entry.isDirectory()) walk(full)
      else out.push(rel)
    }
  }
  walk(root)
  return out.sort()
}

/** Non-test files under the plugin's bundled glue directories (posix, plugin-relative). */
export function listBundledPluginFiles(pluginRoot) {
  const out = []
  for (const dir of BUNDLE_DIRS) {
    const base = join(pluginRoot, dir)
    if (!existsSync(base)) continue
    const walk = (current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (!/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
          out.push(toPosix(relative(pluginRoot, full)))
        }
      }
    }
    walk(base)
  }
  return out.sort()
}

/**
 * The install-ZIP allowlist (`plugin.json` `bundle_include`): docs, the
 * Cognia glue, then every vendored file. Pure.
 *
 * @param {{ pluginFiles: readonly string[], vendorPaths: readonly string[] }} input
 * @returns {string[]}
 */
export function computeBundleInclude({ pluginFiles, vendorPaths }) {
  return [
    ...BUNDLE_DOCS,
    ...[...pluginFiles].sort(),
    ...[...vendorPaths].sort().map((path) => `${VENDOR_DIR}/${path}`),
  ]
}

/**
 * Replace the `"bundle_include": [ … ]` block of a plugin.json text, one entry
 * per line (Prettier's layout for a long string array). Pure.
 *
 * @param {string} manifestText
 * @param {readonly string[]} entries
 * @returns {string}
 */
export function replaceBundleInclude(manifestText, entries) {
  // Entries are plain file paths, so the array ends at its first `]`.
  const block = /\n {2}"bundle_include": \[[^\]]*\]/
  if (!block.test(manifestText)) {
    throw new Error('plugin.json has no top-level "bundle_include" array to rewrite')
  }
  if (entries.some((entry) => entry.includes("]"))) {
    throw new Error('bundle_include entries must not contain "]"')
  }
  const body = entries.map((entry) => `    ${JSON.stringify(entry)}`).join(",\n")
  return manifestText.replace(block, () => `\n  "bundle_include": [\n${body}\n  ]`)
}

/**
 * Render vendor-lock.json. Pure.
 *
 * @param {{ commit: string, commitDate: string, files: Record<string, string> }} lock
 * @returns {string}
 */
export function renderLock({ commit, commitDate, files }) {
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
  return `${JSON.stringify(
    {
      $comment:
        "Generated by scripts/sync-vendor.mjs. Per-file git blob ids of the vendored upstream snapshot; `--check` verifies vendor/ against them.",
      upstream: UPSTREAM_URL,
      commit,
      commitDate,
      files: sorted,
    },
    null,
    2
  )}\n`
}

/**
 * Render VENDOR.md from the lock contents. Pure.
 *
 * @param {{ commit: string, commitDate: string, files: Record<string, string> }} lock
 * @returns {string}
 */
export function renderVendorDoc({ commit, commitDate, files }) {
  const paths = Object.keys(files).sort()
  const rules = [
    ...VENDOR_EXACT_PATHS.map((path) => `- \`${path}\``),
    ...VENDOR_PATTERNS.map(({ rule }) => `- \`${rule}\``),
  ].join("\n")
  return `<!-- Generated by scripts/sync-vendor.mjs — edit the script, not this file. -->

# Vendored upstream: pi-latex-workbench

| Field | Value |
| --- | --- |
| Upstream | <${UPSTREAM_URL}> |
| Commit | \`${commit}\` |
| Commit date | ${commitDate} |
| Files | ${paths.length} |
| Method | \`git archive <commit> -- <paths>\` (never the working tree) |

\`vendor/\` is an **untouched** copy of that commit's archive restricted to the
paths below. Nothing in it is edited for Cognia: the Cognia adapter lives
beside it (\`pi/\`, \`skills/\`, \`src/\`, \`plugin.json\`). Per-file git blob
ids are pinned in \`${LOCK_FILE}\`.

## Path selection

Copied (exact files, then rules):

${rules}

\`packages/contracts/schemas/contracts.schema.json\` is the one addition to the
original selection: \`packages/contracts/src/validators.ts\` reads it at module
initialization, so the CLI and the Pi extension cannot start without it.

Never copied, even when a rule above would match: any path segment named
${VENDOR_EXCLUDED_SEGMENTS.map((s) => `\`${s}\``).join(", ")}, and
${VENDOR_EXCLUDED_PREFIXES.map((s) => `\`${s}\``).join(", ")} (the provisioned
Tectonic bundle and render helper — gitignored upstream, ~5.6 GB).

## Refresh

\`\`\`bash
git -C <upstream> fetch && git -C <upstream> rev-parse <ref>
node plugins/pi-latex-workbench/scripts/sync-vendor.mjs --upstream <upstream> --ref <ref>
pnpm plugin:pi-latex-workbench:check
pnpm test -- plugins/pi-latex-workbench
\`\`\`

The script rewrites \`vendor/\`, \`${LOCK_FILE}\`, this file and the
\`bundle_include\` allowlist in \`plugin.json\`. It keeps local-only directories
(${PRESERVED_VENDOR_DIRS.map((d) => `\`${d}\``).join(", ")}). After a refresh,
re-read the upstream \`packages/cli/src/bin.ts\` and
\`packages/adapter-pi/src/session-control.ts\`: the \`cliTools\` flags and the
hosted-session tool list are derived from them, and \`manifest.test.ts\` fails
when they drift.

## Verify

\`\`\`bash
pnpm plugin:pi-latex-workbench:check                  # offline: vendor/ == ${LOCK_FILE}
node plugins/pi-latex-workbench/scripts/sync-vendor.mjs --check --upstream <upstream>
                                                       # also: ${LOCK_FILE} == the commit's tree
\`\`\`

## License note

The upstream repository carries **no LICENSE file** at this commit, so no
license is granted or implied by this snapshot, and this plugin does not claim
one (\`plugin.json\` \`license\` is \`UNLICENSED\`). Distribution terms must be
confirmed with the upstream owner (Arxtect) before this plugin — or any
artifact containing \`vendor/\` — is published outside this repository.

## Files

<details>
<summary>${paths.length} vendored files</summary>

${paths.map((path) => `- \`${path}\``).join("\n")}

</details>
`
}

function git(upstream, args, options = {}) {
  return execFileSync("git", ["-C", upstream, ...args], {
    encoding: options.encoding ?? "utf8",
    maxBuffer: 512 * 1024 * 1024,
  })
}

/** Resolve `<ref>` to a commit id and its committer date. */
export function resolveCommit(upstream, ref) {
  const commit = git(upstream, ["rev-parse", "--verify", `${ref}^{commit}`]).trim()
  const commitDate = git(upstream, ["show", "-s", "--format=%cI", commit]).trim()
  return { commit, commitDate }
}

/** `{ path → blob id }` of the vendored selection of `commit`'s tree. */
export function upstreamBlobIds(upstream, commit) {
  const raw = git(upstream, ["ls-tree", "-r", "-z", "--full-tree", commit])
  const blobs = new Map()
  for (const record of raw.split("\0")) {
    if (!record) continue
    const tab = record.indexOf("\t")
    const [, type, id] = record.slice(0, tab).split(" ")
    if (type === "blob") blobs.set(record.slice(tab + 1), id)
  }
  const selected = selectVendorPaths([...blobs.keys()])
  return Object.fromEntries(selected.map((path) => [path, blobs.get(path)]))
}

function pruneEmptyDirs(root, dir = root) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = join(dir, entry.name)
    if (isPreserved(toPosix(relative(root, full)))) continue
    pruneEmptyDirs(root, full)
  }
  if (dir !== root && readdirSync(dir).length === 0) rmdirSync(dir)
}

/**
 * Rewrite vendor/ (and every derived file) from `upstream` at `ref`.
 *
 * @param {{ pluginRoot: string, upstream: string, ref: string }} options
 * @returns {{ commit: string, commitDate: string, files: number }}
 */
export function syncVendor({ pluginRoot, upstream, ref }) {
  const { commit, commitDate } = resolveCommit(upstream, ref)
  const files = upstreamBlobIds(upstream, commit)
  const paths = Object.keys(files)
  const vendorRoot = join(pluginRoot, VENDOR_DIR)

  // Delete everything the new snapshot does not contain (local-only dirs
  // excepted), then extract the archive over the remainder.
  mkdirSync(vendorRoot, { recursive: true })
  for (const existing of listVendorFiles(vendorRoot)) {
    rmSync(join(vendorRoot, existing), { force: true })
  }
  pruneEmptyDirs(vendorRoot)
  const archive = spawnSync(
    "git",
    ["-C", upstream, "archive", "--format=tar", commit, "--", ...paths],
    {
      maxBuffer: 1024 * 1024 * 1024,
    }
  )
  if (archive.status !== 0) {
    throw new Error(`git archive failed: ${archive.stderr?.toString() ?? archive.error}`)
  }
  const tar = spawnSync("tar", ["-x", "-f", "-", "-C", vendorRoot], { input: archive.stdout })
  if (tar.status !== 0) {
    throw new Error(`tar extraction failed: ${tar.stderr?.toString() ?? tar.error}`)
  }

  const lock = { commit, commitDate, files }
  writeFileSync(join(pluginRoot, LOCK_FILE), renderLock(lock))
  writeFileSync(join(pluginRoot, VENDOR_DOC), renderVendorDoc(lock))
  const manifestPath = join(pluginRoot, "plugin.json")
  const bundle = computeBundleInclude({
    pluginFiles: listBundledPluginFiles(pluginRoot),
    vendorPaths: paths,
  })
  writeFileSync(manifestPath, replaceBundleInclude(readFileSync(manifestPath, "utf8"), bundle))

  const problems = checkVendor({ pluginRoot })
  if (problems.length > 0) {
    throw new Error(`post-sync verification failed:\n${problems.join("\n")}`)
  }
  return { commit, commitDate, files: paths.length }
}

/**
 * Verify vendor/ and every derived file. Returns human-readable problems
 * (empty = clean). With `upstream`, also proves the lock is exactly the
 * recorded commit's selection.
 *
 * @param {{ pluginRoot: string, upstream?: string }} options
 * @returns {string[]}
 */
export function checkVendor({ pluginRoot, upstream }) {
  const problems = []
  const lockPath = join(pluginRoot, LOCK_FILE)
  if (!existsSync(lockPath)) return [`missing ${LOCK_FILE}`]
  const lock = JSON.parse(readFileSync(lockPath, "utf8"))
  const vendorRoot = join(pluginRoot, VENDOR_DIR)
  const recorded = lock.files ?? {}
  const onDisk = listVendorFiles(vendorRoot)

  for (const path of Object.keys(recorded)) {
    if (!isVendorPath(path)) problems.push(`lock lists a path outside the selection rules: ${path}`)
    const full = join(vendorRoot, path)
    if (!existsSync(full)) {
      problems.push(`missing vendored file: ${path}`)
      continue
    }
    const actual = gitBlobSha1(readFileSync(full))
    if (actual !== recorded[path]) {
      problems.push(`modified vendored file: ${path} (blob ${actual}, recorded ${recorded[path]})`)
    }
  }
  for (const path of onDisk) {
    if (!(path in recorded)) problems.push(`unrecorded file in vendor/: ${path}`)
  }
  if (lock.upstream !== UPSTREAM_URL) problems.push(`lock upstream is ${lock.upstream}`)

  const doc = join(pluginRoot, VENDOR_DOC)
  if (!existsSync(doc) || readFileSync(doc, "utf8") !== renderVendorDoc(lock)) {
    problems.push(`${VENDOR_DOC} is stale — rerun sync-vendor.mjs`)
  }
  if (readFileSync(lockPath, "utf8") !== renderLock(lock)) {
    problems.push(`${LOCK_FILE} is not in canonical form — rerun sync-vendor.mjs`)
  }

  const manifest = JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf8"))
  const expected = computeBundleInclude({
    pluginFiles: listBundledPluginFiles(pluginRoot),
    vendorPaths: Object.keys(recorded),
  })
  if (JSON.stringify(manifest.bundle_include ?? []) !== JSON.stringify(expected)) {
    problems.push("plugin.json bundle_include does not match the vendored + glue file set")
  }

  if (upstream) {
    const truth = upstreamBlobIds(upstream, lock.commit)
    for (const [path, id] of Object.entries(truth)) {
      if (recorded[path] !== id) problems.push(`lock disagrees with ${lock.commit} for ${path}`)
    }
    for (const path of Object.keys(recorded)) {
      if (!(path in truth)) problems.push(`lock lists ${path}, absent from ${lock.commit}`)
    }
  }
  return problems
}

function parseCli(argv) {
  const options = { check: false, upstream: undefined, ref: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--check") options.check = true
    else if (arg === "--upstream") options.upstream = argv[++i]
    else if (arg === "--ref") options.ref = argv[++i]
    else throw new Error(`unknown argument ${arg}`)
  }
  if (!options.check && (!options.upstream || !options.ref)) {
    throw new Error(
      "usage: sync-vendor.mjs --upstream <dir> --ref <ref> | --check [--upstream <dir>]"
    )
  }
  return options
}

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseCli(process.argv.slice(2))
    const upstream = options.upstream ? resolve(options.upstream) : undefined
    if (options.check) {
      const problems = checkVendor({ pluginRoot, upstream })
      if (problems.length > 0) {
        console.error(problems.join("\n"))
        process.exitCode = 1
      } else {
        console.log(`vendor/ matches ${LOCK_FILE}${upstream ? " and the upstream commit" : ""}`)
      }
    } else {
      const result = syncVendor({ pluginRoot, upstream, ref: options.ref })
      console.log(`Vendored ${result.files} files from ${result.commit} (${result.commitDate})`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
