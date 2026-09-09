#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseRegisteredCommands } from "./lib/generate-handler.mjs"
import { DISPATCH_SOURCES, hasArm } from "./check-command-grammar.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

/** Where the generator renders the contract into Rust (ADR-0175). */
export const KNOWN_COMMANDS_RUST_PATH = "src-tauri/src/companion_api/generated/known_commands.rs"

const ENUMS = {
  target: new Set(["client", "execution", "host-admin", "service"]),
  operation: new Set(["read", "write", "side-effect"]),
  risk: new Set(["low", "high", "critical"]),
  approval: new Set(["none", "interactive", "signed-policy"]),
  idempotency: new Set(["structural", "required", "forbidden"]),
}

export function validateManifest(manifest) {
  const errors = []
  if (!Number.isInteger(manifest.contractVersion) || !Array.isArray(manifest.commands)) {
    return ["manifest must have an integer contractVersion and a commands array"]
  }

  const names = new Set()
  for (const command of manifest.commands) {
    const label = command?.name || "<unnamed>"
    if (typeof command?.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(command.name)) {
      errors.push(`${label}: invalid command name`)
      continue
    }
    if (names.has(command.name)) errors.push(`${label}: duplicate command`)
    names.add(command.name)
    for (const [field, allowed] of Object.entries(ENUMS)) {
      if (!allowed.has(command[field])) errors.push(`${label}: invalid ${field}`)
    }
    if (typeof command.capability !== "string" || command.capability.length === 0) {
      errors.push(`${label}: capability is required`)
    }
    if (command.operation !== "read" && command.idempotency !== "required") {
      errors.push(`${label}: mutations require idempotency`)
    }
    if (
      (command.target === "client" || command.target === "service") &&
      (command.transports.length !== 1 || command.transports[0] !== "internal")
    ) {
      errors.push(`${label}: ${command.target} commands must be internal-only`)
    }
    if (!command.inputSchema || !command.outputSchema) {
      errors.push(`${label}: inputSchema and outputSchema are required`)
    }
    // Grammar fields (ADR-0175). Their values are held to the resource tree and
    // verb vocabulary by check-command-grammar; this gate only insists they exist.
    for (const field of ["resource", "verb", "arm"]) {
      if (typeof command[field] !== "string" || command[field].length === 0) {
        errors.push(`${label}: ${field} is required`)
      }
    }
    if (!["none", "page-token", "byte-range"].includes(command.pagination)) {
      errors.push(`${label}: invalid pagination`)
    }
    if (typeof command.longRunning !== "boolean") errors.push(`${label}: longRunning is required`)
  }
  return errors
}

/**
 * Every descriptor must be answered by something real.
 *
 * `registered` is the set of `generate_handler!` names (the desktop IPC face).
 * `dispatchArms` answers `has(arm)` over the companion dispatch sources. A
 * remote descriptor (target other than `client`) is what the generated
 * allowlist admits, so its `arm` must exist in a dispatcher or the command
 * 404s at runtime while every catalog advertises it. A client descriptor must
 * be a registered Tauri command. The old shape of this check compared the
 * manifest against `KNOWN_COMMANDS`, a hand-typed copy of the same list, which
 * could only ever prove the two copies agreed.
 */
export function compareCommandSets(manifest, registered, dispatchArms) {
  const errors = []
  for (const command of manifest.commands) {
    const arm = command.arm ?? command.name
    if (command.target !== "client") {
      if (!dispatchArms.has(arm)) {
        errors.push(`remote command has no dispatch arm — add one or drop the descriptor: ${command.name}`)
      }
      continue
    }
    // The reverse direction. A descriptor is how a companion *discovers* a
    // command, so one left behind after its handler was deleted is worse than a
    // missing descriptor: the client finds the command, calls it, and gets a
    // dispatch error it cannot distinguish from an outage.
    if (!isBacked(command.name, registered, dispatchArms)) {
      errors.push(`descriptor has no handler — delete it or register one: ${command.name}`)
    }
  }
  return errors
}

/**
 * Whether some dispatcher can actually answer this client command.
 *
 * `plugin_*` names are declared by plugins at runtime through
 * `anthropicTools[].executeIpc.invoke`, so they are dispatched dynamically and
 * cannot appear in either static set.
 */
function isBacked(name, registered, dispatchArms) {
  return registered.has(name) || dispatchArms.has(name) || name.startsWith("plugin_")
}

/**
 * The generated Rust table must be the manifest's contract version. Row
 * parity is proven by `generated_table_matches_protocol_contract` in
 * `command_manifest.rs` and by `pnpm companion-api:check`; this is the cheap
 * half that catches an unregenerated table before either runs.
 */
export function checkGeneratedTable(manifest, rustSource) {
  const match = rustSource.match(/^pub const CONTRACT_VERSION: u32 = (\d+);$/m)
  if (!match) return [`${KNOWN_COMMANDS_RUST_PATH}: missing CONTRACT_VERSION — run pnpm companion-api:gen`]
  if (Number(match[1]) !== manifest.contractVersion) {
    return [
      `${KNOWN_COMMANDS_RUST_PATH}: CONTRACT_VERSION ${match[1]} lags manifest ${manifest.contractVersion} — run pnpm companion-api:gen`,
    ]
  }
  const rows = rustSource.match(/^\s+WireCommand \{ name: "/gm)?.length ?? 0
  if (rows !== manifest.commands.length) {
    return [
      `${KNOWN_COMMANDS_RUST_PATH}: ${rows} rows for ${manifest.commands.length} descriptors — run pnpm companion-api:gen`,
    ]
  }
  return []
}

/** `has(arm)` over the dispatch sources the grammar gate lists. */
export function dispatchArmIndex(sources) {
  const cache = new Map()
  return {
    has(arm) {
      if (!cache.has(arm)) cache.set(arm, sources.some((source) => hasArm(source, arm)))
      return cache.get(arm)
    },
  }
}

function readRepo(path) {
  return readFileSync(resolve(repoRoot, path), "utf8")
}

function main() {
  const manifest = JSON.parse(readRepo("protocol/companion-commands.json"))
  const libSource = readRepo("src-tauri/src/lib.rs")
  const dispatchArms = dispatchArmIndex(
    DISPATCH_SOURCES.map((path) => {
      try {
        return readRepo(path)
      } catch {
        return ""
      }
    })
  )
  let rustSource = ""
  try {
    rustSource = readRepo(KNOWN_COMMANDS_RUST_PATH)
  } catch {
    // Reported by checkGeneratedTable as a missing CONTRACT_VERSION.
  }
  const registered = parseRegisteredCommands(libSource)
  const errors = [
    ...validateManifest(manifest),
    ...compareCommandSets(manifest, registered, dispatchArms),
    ...checkGeneratedTable(manifest, rustSource),
  ]

  if (errors.length > 0) {
    console.error(`[companion-command-manifest] ${errors.length} issue(s):`)
    for (const error of errors) console.error(`  - ${error}`)
    return 1
  }
  const remote = manifest.commands.filter((command) => command.target !== "client").length
  console.log(
    `[companion-command-manifest] OK: ${manifest.commands.length} descriptors cover ` +
      `${registered.size} Tauri registrations and ${remote} remote execution commands ` +
      `(contract v${manifest.contractVersion}).`
  )
  return 0
}

const isDirectRun = (() => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isDirectRun) process.exit(main())
