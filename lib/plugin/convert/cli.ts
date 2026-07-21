/**
 * Node entry for `cognia plugin import`.
 *
 * The Rust CLI owns the user-facing command; this module owns the actual
 * conversion, because the parsers it reuses (thirteen agent-config
 * adapters in `lib/claude/agents/*`, the SKILL.md frontmatter parser in
 * `lib/claude/skills-io`) are TypeScript and re-implementing any of them
 * in Rust would create a second surface to keep in sync — the exact defect
 * class that produced the four hand-copied parity lists in `cmd_lint.rs`.
 *
 * The wire contract is one JSON object on stdout. Rust renders it; this
 * side never prints prose, so a locale or colour setting can never corrupt
 * the protocol. Errors are reported the same way (`ok: false`) plus a
 * non-zero exit, so the Rust side has one shape to parse either way.
 *
 * Filesystem access is injected (`ConvertIo`) so every branch here — path
 * resolution, refusing a non-empty target, resource discovery, the merge
 * path — is unit-tested without touching a real disk.
 */

import { convert, listCandidates } from "./index"
import { BUNDLE_RESOURCE_DIRS } from "./skill-source"
import type { ConvertIdentityOverrides, ConvertSourceKind } from "./types"

/** The filesystem operations the CLI needs. */
export interface ConvertIo {
  readFile(path: string): string
  writeFile(path: string, contents: string): void
  copyFile(from: string, to: string): void
  mkdirp(path: string): void
  exists(path: string): boolean
  isDirectory(path: string): boolean
  /** Entry names directly inside `path` (not recursive). */
  readDir(path: string): string[]
  /** Recursive file list relative to `path`. */
  listFiles(path: string): string[]
  join(...segments: string[]): string
  basename(path: string): string
  resolve(path: string): string
  /** `git config user.name`, or undefined when unavailable. */
  gitAuthor(): string | undefined
}

export interface ConvertCliOutput {
  ok: boolean
  /** Present when `ok: false`. */
  error?: string
  mode?: "create" | "merge" | "list"
  pluginId?: string
  /** Absolute path of the directory that was written. */
  dir?: string
  /** Paths written, relative to `dir`. */
  files?: string[]
  candidates?: Array<{ id: string; label: string; detail?: string }>
  todos?: string[]
  warnings?: string[]
  /** Relative path of the entry the Rust side should build, if any. */
  buildTarget?: string
}

const SOURCE_KINDS: ConvertSourceKind[] = ["mcp", "skill", "cli"]

/** Flags that take a value. */
const VALUE_FLAGS = new Set([
  "--from",
  "--input",
  "--pick",
  "--into",
  "--dir",
  "--id",
  "--name",
  "--description",
  "--plugin-version",
  "--author",
  "--author-email",
  "--license",
  "--min-app-version",
  "--host-version",
])

export interface ParsedArgs {
  from: ConvertSourceKind
  input: string
  pick?: string
  into?: string
  dir?: string
  list: boolean
  hostVersion?: string
  identity: ConvertIdentityOverrides
}

/** Parse argv (already stripped of the node binary and script path). */
export function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>()
  let list = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--list") {
      list = true
      continue
    }
    if (!VALUE_FLAGS.has(arg)) {
      throw new Error(`unknown option: ${arg}`)
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${arg}`)
    }
    values.set(arg, value)
    i += 1
  }

  const from = values.get("--from")
  if (!from) throw new Error("--from is required (mcp | skill | cli)")
  if (!SOURCE_KINDS.includes(from as ConvertSourceKind)) {
    throw new Error(`--from must be one of ${SOURCE_KINDS.join(" | ")}, got "${from}"`)
  }
  const input = values.get("--input")
  if (!input) throw new Error("--input is required")

  return {
    from: from as ConvertSourceKind,
    input,
    pick: values.get("--pick"),
    into: values.get("--into"),
    dir: values.get("--dir"),
    list,
    hostVersion: values.get("--host-version"),
    identity: {
      id: values.get("--id"),
      name: values.get("--name"),
      description: values.get("--description"),
      version: values.get("--plugin-version"),
      author: values.get("--author"),
      authorEmail: values.get("--author-email"),
      license: values.get("--license"),
      minAppVersion: values.get("--min-app-version"),
    },
  }
}

/**
 * Resolve the source text and, for skills, the sibling resources.
 *
 * A skill input may be the folder or the SKILL.md itself; both are
 * accepted because both are what a user has in hand.
 */
function readSource(
  args: ParsedArgs,
  io: ConvertIo
): { text?: string; sourceName?: string; resources?: string[]; skillRoot?: string } {
  if (args.from === "cli") return {}

  const path = io.resolve(args.input)
  if (!io.exists(path)) throw new Error(`no such file or directory: ${path}`)

  if (args.from === "mcp") {
    if (io.isDirectory(path)) {
      throw new Error(
        `--input must be an agent config file for --from mcp, got a directory: ${path}`
      )
    }
    return { text: io.readFile(path), sourceName: args.input }
  }

  // skill
  const skillRoot = io.isDirectory(path) ? path : dirnameOf(path)
  const skillMd = io.isDirectory(path) ? io.join(path, "SKILL.md") : path
  if (!io.exists(skillMd)) {
    throw new Error(`no SKILL.md in ${skillRoot}`)
  }
  const resources = io
    .listFiles(skillRoot)
    .filter((rel) => rel !== "SKILL.md")
    .sort()
  return {
    text: io.readFile(skillMd),
    sourceName: io.basename(skillRoot),
    resources,
    skillRoot,
  }
}

function dirnameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return idx <= 0 ? path : path.slice(0, idx)
}

/**
 * Refuse to write into a directory that already holds files.
 *
 * `plugin new` behaves the same way, and for the same reason: a converter
 * that merges into whatever is already there would silently clobber an
 * author's work. `--into` is the explicit, narrow way to touch an
 * existing plugin.
 */
function assertWritableTarget(dir: string, io: ConvertIo): void {
  if (!io.exists(dir)) return
  if (!io.isDirectory(dir)) throw new Error(`${dir} exists and is not a directory`)
  const entries = io.readDir(dir).filter((name) => name !== "." && name !== "..")
  if (entries.length > 0) {
    throw new Error(
      `${dir} is not empty — pass --dir to choose another location, or --into <dir> to add this contribution to the plugin already there`
    )
  }
}

/** Run one `cognia plugin import` invocation. */
export function runConvertCli(argv: string[], io: ConvertIo): ConvertCliOutput {
  const args = parseArgs(argv)
  const source = readSource(args, io)

  const input = {
    kind: args.from,
    text: source.text,
    sourceName: source.sourceName,
    resources: source.resources,
    binary: args.from === "cli" ? args.input : undefined,
    pick: args.pick,
    identity: args.identity,
  }

  if (args.list) {
    return { ok: true, mode: "list", candidates: listCandidates(input) }
  }

  // A single-candidate input needs no `--pick`; supplying one is still fine.
  if (!args.pick) {
    const candidates = listCandidates(input)
    if (candidates.length === 1) input.pick = candidates[0].id
  }

  if (args.into) {
    const intoDir = io.resolve(args.into)
    const manifestPath = io.join(intoDir, "plugin.json")
    if (!io.exists(manifestPath)) {
      throw new Error(`${manifestPath} not found — --into expects an existing plugin directory`)
    }
    const result = convert(input, {
      hostVersion: args.hostVersion,
      gitAuthor: io.gitAuthor(),
      existingManifestText: io.readFile(manifestPath),
      existingManifestPath: manifestPath,
    })
    io.writeFile(manifestPath, result.files.get("plugin.json")!)
    copyResources(result.copies, source.skillRoot, intoDir, io)
    return {
      ok: true,
      mode: "merge",
      pluginId: result.pluginId,
      dir: intoDir,
      files: ["plugin.json", ...result.copies.map((c) => c.to)],
      todos: result.todos,
      warnings: result.warnings,
    }
  }

  const result = convert(input, {
    hostVersion: args.hostVersion,
    gitAuthor: io.gitAuthor(),
  })
  const dir = io.resolve(args.dir ?? result.pluginId)
  assertWritableTarget(dir, io)

  const written: string[] = []
  for (const [relative, contents] of result.files) {
    const target = io.join(dir, relative)
    io.mkdirp(dirnameOf(target))
    io.writeFile(target, contents)
    written.push(relative)
  }
  written.push(...copyResources(result.copies, source.skillRoot, dir, io))

  return {
    ok: true,
    mode: "create",
    pluginId: result.pluginId,
    dir,
    files: written.sort(),
    todos: result.todos,
    warnings: result.warnings,
    buildTarget: "dist/index.js",
  }
}

function copyResources(
  copies: Array<{ from: string; to: string }>,
  sourceRoot: string | undefined,
  targetDir: string,
  io: ConvertIo
): string[] {
  if (copies.length === 0) return []
  if (!sourceRoot) {
    throw new Error("internal: resource copies requested without a source directory")
  }
  const written: string[] = []
  for (const copy of copies) {
    const target = io.join(targetDir, copy.to)
    io.mkdirp(dirnameOf(target))
    io.copyFile(io.join(sourceRoot, copy.from), target)
    written.push(copy.to)
  }
  return written
}

/** Wrap `runConvertCli` so failures leave the process with one JSON shape. */
export function runMain(argv: string[], io: ConvertIo): { output: string; exitCode: number } {
  try {
    const result = runConvertCli(argv, io)
    return { output: JSON.stringify(result), exitCode: 0 }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { output: JSON.stringify({ ok: false, error: message }), exitCode: 1 }
  }
}

/** Re-exported so the Rust-side docs and the README stay in step. */
export { BUNDLE_RESOURCE_DIRS }
