#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseRegisteredCommands } from "./lib/generate-handler.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

const ENUMS = {
  target: new Set(["client", "execution", "host-admin", "service"]),
  operation: new Set(["read", "write", "side-effect"]),
  risk: new Set(["low", "high", "critical"]),
  approval: new Set(["none", "interactive", "signed-policy"]),
  idempotency: new Set(["structural", "required", "forbidden"]),
}

function extractRustArray(source, name) {
  const match = source.match(new RegExp(`const ${name}[^=]*= &\\[([\\s\\S]*?)\\n\\];`))
  if (!match) throw new Error(`Could not locate Rust ${name}`)
  return new Set([...match[1].matchAll(/"([a-z0-9_]+)"/g)].map((entry) => entry[1]))
}

export function validateManifest(manifest) {
  const errors = []
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.commands)) {
    return ["manifest must have schemaVersion 1 and a commands array"]
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
    if (command.since !== 1 && command.since !== 2) {
      errors.push(`${label}: since must be 1 or 2`)
    }
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
  }
  return errors
}

export function compareCommandSets(manifest, registered, legacyRpc) {
  const errors = []
  const byName = new Map(manifest.commands.map((command) => [command.name, command]))
  for (const name of registered) {
    if (!byName.has(name)) errors.push(`registered Tauri command missing from manifest: ${name}`)
  }
  for (const name of legacyRpc) {
    if (byName.get(name)?.since !== 1) {
      errors.push(`legacy RPC missing since:1 descriptor: ${name}`)
    }
  }
  for (const command of manifest.commands) {
    if (command.since === 1 && !legacyRpc.has(command.name)) {
      errors.push(`since:1 descriptor is not in the v1 RPC allowlist: ${command.name}`)
    }
    // The reverse direction. A descriptor is how a companion *discovers* a
    // command, so one left behind after its handler was deleted is worse than a
    // missing descriptor: the client finds the command, calls it, and gets a
    // dispatch error it cannot distinguish from an outage.
    if (!isBacked(command.name, registered, legacyRpc)) {
      errors.push(`descriptor has no handler — delete it or register one: ${command.name}`)
    }
  }
  return errors
}

/**
 * Whether some dispatcher can actually answer this command.
 *
 * `plugin_*` names are declared by plugins at runtime through
 * `anthropicTools[].executeIpc.invoke`, so they are dispatched dynamically and
 * cannot appear in either static set.
 */
function isBacked(name, registered, legacyRpc) {
  return registered.has(name) || legacyRpc.has(name) || name.startsWith("plugin_")
}

function main() {
  const manifest = JSON.parse(
    readFileSync(resolve(repoRoot, "protocol/companion-commands.json"), "utf8")
  )
  const libSource = readFileSync(resolve(repoRoot, "src-tauri/src/lib.rs"), "utf8")
  const rpcSource = readFileSync(resolve(repoRoot, "src-tauri/src/companion_api/rpc.rs"), "utf8")
  const errors = [
    ...validateManifest(manifest),
    ...compareCommandSets(
      manifest,
      parseRegisteredCommands(libSource),
      extractRustArray(rpcSource, "KNOWN_COMMANDS")
    ),
  ]

  if (errors.length > 0) {
    console.error(`[companion-command-manifest] ${errors.length} issue(s):`)
    for (const error of errors) console.error(`  - ${error}`)
    return 1
  }
  console.log(
    `[companion-command-manifest] OK: ${manifest.commands.length} descriptors cover ` +
      `${parseRegisteredCommands(libSource).size} Tauri registrations and ` +
      `${extractRustArray(rpcSource, "KNOWN_COMMANDS").size} v1 RPC commands.`
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
