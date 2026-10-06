#!/usr/bin/env node
/**
 * Compare literal renderer invoke argument keys with registered Tauri command
 * signatures. Dynamic argument objects are opaque; spreads and computed keys
 * still permit unknown-key checks but cannot prove a required key is absent.
 * Omitted argument objects are empty, not opaque.
 *
 * Reuses the RPC signature parser and field normalization (case/underscore
 * insensitive). This is a top-level presence check, not a payload type checker
 * or exact Tauri rename_all validation. Dynamic command names and invoke
 * wrapper aliases are out of scope. Existing debt may only shrink.
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  COMMAND_ROOTS,
  extractBalanced,
  normalizeField,
  parseTauriCommands,
  stripRustComments,
  splitParams,
} from "./check-rpc-semantic-parity.mjs"
import { extractGenerateHandlerBlock } from "./lib/generate-handler.mjs"
import { findInvokeCallSites } from "./lib/invoke-call-sites.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "../..")
const BASELINE_PATH = join(__dirname, "invoke-arg-parity-baseline.json")

/**
 * Renderer trees that may call `invoke`. `plugins` is included on purpose —
 * `check-command-parity.mjs` omits it, so first-party plugin code is the one
 * place invoke calls have never been checked at all.
 */
const RENDERER_ROOTS = ["app", "components", "hooks", "stores", "lib", "plugins", "packages"]

const TS_EXTENSIONS = /\.(ts|tsx|mts|cts)$/

const gitFiles = (patterns) =>
  execFileSync("git", ["ls-files", ...patterns], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64e6,
  })
    .split("\n")
    .filter(Boolean)

const read = (file) => readFileSync(join(REPO_ROOT, file), "utf8")

/**
 * The invoke inventory includes desktop-only attributes that the shared RPC
 * parser does not expand. Normalize here, preserving newlines
 * and reusing its injected-state/channel/parameter rules unchanged.
 */
export function parseInvokeCommands(rawSource, file) {
  const source = stripRustComments(rawSource)
  const replacements = []
  for (const match of source.matchAll(/#\[cfg_attr\s*\(/g)) {
    const block = extractBalanced(source, match.index + match[0].length - 1, "(", ")")
    if (!block || source[block.end + 1] !== "]") continue
    const attributes = splitParams(block.text).slice(1)
    const command = attributes.find((attribute) => /^tauri::command(?:\s*\(|$)/.test(attribute))
    if (!command) continue
    const end = block.end + 2
    const newlines = source.slice(match.index, end).match(/\n/g)?.length ?? 0
    const retainedNewlines = command.match(/\n/g)?.length ?? 0
    replacements.push({
      start: match.index,
      end,
      value: `#[${command}]${"\n".repeat(newlines - retainedNewlines)}`,
    })
  }
  let expanded = source
  for (const replacement of replacements.reverse()) {
    expanded =
      expanded.slice(0, replacement.start) + replacement.value + expanded.slice(replacement.end)
  }
  const commands = parseTauriCommands(expanded, file)

  // This macro's explicit fields are its generated Rust signature. Limit the
  // adapter to its owning module; unknown macros remain unresolved and fail
  // the registration inventory instead of being guessed into coverage.
  if (file !== "src-tauri/src/sftp_service.rs") return commands
  for (const match of source.matchAll(/\bdesktop_sftp_command!\s*\(/g)) {
    const block = extractBalanced(source, match.index + match[0].length - 1, "(", ")")
    const parts = block ? splitParams(block.text) : []
    if (
      parts.length !== 3 ||
      !/^[A-Za-z_]\w*$/.test(parts[0]) ||
      !/^"[^"\n]+"$/.test(parts[1]) ||
      !/^\[[\s\S]*\]$/.test(parts[2])
    ) {
      throw new Error(`Unsupported SFTP command macro in ${file}`)
    }
    const params = splitParams(parts[2].slice(1, -1)).map((field) => {
      const parsed = field.match(/^([A-Za-z_]\w*)\s+as\s+"[^"\n]+"\s*:\s*([\s\S]+)$/)
      if (!parsed) throw new Error(`Unsupported SFTP field in ${file}: ${field}`)
      return `${parsed[1]}: ${parsed[2]}`
    })
    const [command] = parseTauriCommands(
      `#[tauri::command]\npub async fn ${parts[0]}(${params.join(", ")}) {}`,
      file
    )
    if (!command) throw new Error(`Unsupported SFTP signature in ${file}: ${parts[0]}`)
    commands.push({ ...command, line: source.slice(0, match.index).split("\n").length })
  }
  return commands
}

/**
 * Bounded re-export resolution for the one ambiguous desktop facade. The
 * source statement is the proof; a moved/changed facade must be reviewed,
 * never resolved by candidate order or the crate's similar command name.
 */
export function verifiedRegistrationOwners(sources) {
  const facade = stripRustComments(sources.get("src-tauri/src/task_workspace.rs") ?? "")
  return new Map(
    /^\s*pub\s+use\s+cognia_task_workspace_host::host_surface::\*\s*;/m.test(facade)
      ? [["task_workspace", "crates/cognia-task-workspace-host/src/host_surface.rs"]]
      : []
  )
}

/** Select only registered definitions, never an unrelated same-name command. */
export function selectRegisteredCommands(definitions, source, owners = new Map()) {
  const block = extractGenerateHandlerBlock(stripRustComments(source))
  const registrations = new Map()
  for (const raw of block.split(",")) {
    const path = raw.trim()
    if (!path) continue
    if (!/^(?:[A-Za-z_]\w*::)*[A-Za-z_]\w*$/.test(path)) {
      throw new Error(`Unsupported generate_handler! entry: ${path}`)
    }
    const segments = path.split("::")
    const name = segments.at(-1)
    if (registrations.has(name)) throw new Error(`Duplicate registered command ${name}`)
    registrations.set(name, segments.slice(0, -1))
  }
  const commands = new Map()
  for (const [name, modules] of registrations) {
    const candidates = definitions.filter((command) => command.name === name)
    if (candidates.length === 0) {
      throw new Error(`Unresolved registered command ${[...modules, name].join("::")}`)
    }
    const ownerFile = owners.get(modules.join("::"))
    if (candidates.length === 1 && !ownerFile) {
      commands.set(name, candidates[0])
      continue
    }
    const moduleName = modules.at(-1)
    const matching = candidates.filter((command) =>
      ownerFile
        ? command.file === ownerFile
        : moduleName &&
          (command.file.includes(`/${moduleName}/`) || command.file.endsWith(`/${moduleName}.rs`))
    )
    if (matching.length !== 1) {
      throw new Error(
        `Ambiguous registered command ${name}: ${candidates.map((c) => c.file).join(", ")}`
      )
    }
    commands.set(name, matching[0])
  }
  return commands
}

export function collectRegisteredCommands() {
  const definitions = []
  const sources = new Map()
  for (const file of gitFiles(["*.rs"]).filter((f) =>
    COMMAND_ROOTS.some((root) => f.startsWith(root))
  )) {
    if (existsSync(join(REPO_ROOT, file))) {
      const source = read(file)
      sources.set(file, source)
      definitions.push(...parseInvokeCommands(source, file))
    }
  }
  return selectRegisteredCommands(
    definitions,
    read("src-tauri/src/lib.rs"),
    verifiedRegistrationOwners(sources)
  )
}

function rendererCallSites() {
  const sites = []
  for (const file of gitFiles(RENDERER_ROOTS)) {
    if (!TS_EXTENSIONS.test(file)) continue
    if (/\.(test|spec|stories)\.[mc]?tsx?$/.test(file)) continue
    if (/\/(?:__tests__|__mocks__)\//.test(file) || !existsSync(join(REPO_ROOT, file))) continue
    sites.push(...findInvokeCallSites(read(file), file))
  }
  return sites
}

const isOptional = (type) =>
  /^(?:(?:std|core)::option::)?Option\s*</.test(type.trim().replace(/^&/, ""))

export function findingKey(site, kind, field) {
  return `${site.file}:${site.command}:${kind}:${field}`
}

/**
 * Every argument-shape disagreement. Pure, so the test can drive it with
 * fixtures instead of the repository.
 */
export function analyze(callSites, commands) {
  const findings = []
  for (const site of callSites) {
    if (site.kind === "opaque") continue
    const command = commands.get(site.command)
    // An unregistered command is `audit:command-parity`'s finding, not ours.
    if (!command) continue

    const sent = new Set(site.keys.map(normalizeField))
    const declared = new Map(command.params.map((p) => [normalizeField(p.name), p]))
    // The RPC parser separates non-optional Channel<T> parameters from JSON
    // payload fields. They still require a renderer-supplied channel ID.
    const channels = new Set(command.channelParams.map(normalizeField))

    for (const key of site.keys) {
      const normalized = normalizeField(key)
      if (!declared.has(normalized) && !channels.has(normalized)) {
        findings.push({
          key: findingKey(site, "unknown-argument", key),
          detail:
            `${site.file}:${site.line} invoke("${site.command}") sends \`${key}\`, which ` +
            `${command.file}:${command.line} does not declare — it is dropped in transit.`,
        })
      }
    }

    // A spread can supply anything, so absence proves nothing.
    if (site.hasSpread) continue

    for (const param of [
      ...command.params,
      ...command.channelParams.map((name) => ({ name, type: "Channel" })),
    ]) {
      if (isOptional(param.type)) continue
      if (!sent.has(normalizeField(param.name))) {
        findings.push({
          key: findingKey(site, "missing-argument", param.name),
          detail:
            `${site.file}:${site.line} invoke("${site.command}") omits \`${param.name}\` ` +
            `(${param.type}), which ${command.file}:${command.line} requires.`,
        })
      }
    }
  }
  return findings.sort((a, b) => a.key.localeCompare(b.key))
}

/** Every finding in the repository as it stands. Used by the gate and its test. */
export function collectRepositoryFindings() {
  return analyze(rendererCallSites(), collectRegisteredCommands())
}

export function readBaseline(path = BASELINE_PATH) {
  if (!existsSync(path)) return []
  const parsed = JSON.parse(readFileSync(path, "utf8"))
  return Array.isArray(parsed.findings) ? parsed.findings : []
}

export function diffAgainstBaseline(findings, baseline) {
  const known = new Set(baseline)
  const current = new Set(findings.map((f) => f.key))
  return {
    added: findings.filter((f) => !known.has(f.key)),
    removed: baseline.filter((key) => !current.has(key)),
  }
}

function writeBaseline(findings) {
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        version: 1,
        note:
          "Renderer invoke() call sites whose argument keys disagree with the " +
          "#[tauri::command] signature they name. THIS LIST MAY ONLY SHRINK — " +
          "`pnpm audit:invoke-arg-parity` fails when a key appears that is not " +
          "listed here. Regenerate with `--write-baseline` only after fixing call " +
          "sites, never to admit a new mismatch.",
        findings: findings.map((f) => f.key),
      },
      null,
      2
    )}\n`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const findings = collectRepositoryFindings()

  if (process.argv.includes("--write-baseline")) {
    const { added } = diffAgainstBaseline(findings, readBaseline())
    if (added.length > 0) {
      console.error(
        "[invoke-arg-parity] refusing to baseline new mismatches; fix the call sites first."
      )
      for (const finding of added) console.error(`  ${finding.detail}`)
      process.exitCode = 1
    } else {
      writeBaseline(findings)
      console.log(`[invoke-arg-parity] baseline written: ${findings.length} findings`)
    }
  } else {
    const { added, removed } = diffAgainstBaseline(findings, readBaseline())
    if (added.length > 0) {
      console.error(
        `[invoke-arg-parity] ${added.length} NEW invoke/command argument mismatch(es).\n` +
          `An unknown argument is dropped in transit; a missing required one fails the\n` +
          `call at runtime. Tests that mock invoke() cannot see either.\n`
      )
      for (const finding of added) console.error(`  ${finding.detail}`)
      process.exitCode = 1
    } else if (removed.length > 0) {
      console.log(
        `[invoke-arg-parity] ${removed.length} mismatch(es) fixed — lock it in with\n` +
          `  pnpm audit:invoke-arg-parity -- --write-baseline`
      )
      for (const key of removed) console.log(`  - ${key}`)
    } else {
      console.log(`[invoke-arg-parity] no new argument mismatches (${findings.length} known).`)
    }
  }
}
