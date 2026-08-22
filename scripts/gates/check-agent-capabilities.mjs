#!/usr/bin/env node
/**
 * Gate: the external-agent SSOT stays a single source (ADR-0090).
 *
 * Two manifests, each with consumers that must not disagree with them:
 *
 *   • `protocol/agent-capabilities.json` — what each external protocol can do.
 *     Read by the renderer, the CLI, the TUI and the execution resolver.
 *   • `protocol/external-agent-security-policy.json` — what Cognia is willing
 *     to launch. Read directly by TypeScript, and MIRRORED as compiled-in
 *     literals by `crates/cognia-external-agent` (a security allowlist must not
 *     depend on parsing a file at runtime).
 *
 * The Rust half is the reason this gate exists. Before it, the only thing
 * binding the two languages was a comment asking future readers to "keep the
 * two in union", and they had already drifted in three ways at once: Rust
 * refused the `claude-agent-acp` binary the `claude-code` preset actually
 * spawns, carried a `cline` entry no preset references, and neither side gave
 * OpenCode a writable state root.
 *
 * What is checked:
 *   1. capability manifest — schema, completeness, evidence discipline;
 *   2. capability manifest ⇄ the TS capability vocabulary;
 *   3. capability manifest ⇄ the protocols `manager.ts` actually registers;
 *   4. security policy ⇄ Rust `BINARY_ALLOWLIST` / `NPX_PACKAGE_ALLOWLIST`;
 *   5. security policy ⇄ Rust `agent_state_writable_roots`;
 *   6. every allowlisted binary is reachable from a shipped preset.
 *
 * What is NOT checked, and why: plugin lifecycle (registration on enable,
 * teardown on disable) is RUNTIME behaviour. A regex claiming to have proven it
 * would be worse than no check — it would read as coverage. That half is pinned
 * by `lib/plugin/bridge/external-agent-adapters-bridge.test.ts` and the
 * capability-profile cases in `lib/ai/agent/external/manager.test.ts`.
 *
 * Usage: pnpm audit:agent-capabilities
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

const read = (rel) => readFileSync(join(REPO_ROOT, rel), "utf8")
const readJson = (rel) => JSON.parse(read(rel))

const CAPABILITY_MANIFEST = "protocol/agent-capabilities.json"
const SECURITY_POLICY = "protocol/external-agent-security-policy.json"
const CONTRACT_TS = "packages/agent-config-types/src/external-agent-capability.ts"
const EXECUTION_TS = "packages/agent-config-types/src/agent-execution.ts"
const MANAGER_TS = "lib/ai/agent/external/manager.ts"
const RUST_PRESETS = "crates/cognia-external-agent/src/presets.rs"
const RUST_SANDBOX = "crates/cognia-external-agent/src/sandbox.rs"
const ECOSYSTEM_TS = "lib/ai/agent/external/ecosystem-adapters.ts"
const PRESETS_TS = "lib/ai/agent/external/presets.ts"

const LEVELS = new Set(["native", "equivalent", "unsupported", "unknown"])

/** Comments quote ids freely; a comment is never a table entry. */
const stripComments = (block) => block.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")

/** Every `"…"` string literal in a block, comments removed. */
export function stringsIn(block) {
  return [...stripComments(block).matchAll(/"([^"]+)"/g)].map((m) => m[1])
}

/** The array body of `const NAME: &[&str] = &[ … ];` in a Rust source. */
export function rustStrArray(source, name) {
  const body = source.match(new RegExp(`const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\n\\];`))?.[1]
  if (body === undefined) throw new Error(`${name} not found`)
  return stringsIn(body)
}

/** The v2 capability ids, from the frozen `AGENT_CAPABILITY_IDS` list. */
export function specCapabilityIds(source) {
  const body = source.match(
    /AGENT_CAPABILITY_IDS: readonly AgentCapabilityId\[\] = \[([\s\S]*?)\n\]/
  )?.[1]
  if (!body) throw new Error("AGENT_CAPABILITY_IDS not found")
  return stringsIn(body)
}

/** The external-only ids added on top of the v2 vocabulary. */
export function externalOnlyCapabilityIds(source) {
  const body = source.match(
    /EXTERNAL_ONLY_CAPABILITY_IDS: readonly ExternalOnlyCapabilityId\[\] = \[([\s\S]*?)\n\]/
  )?.[1]
  if (!body) throw new Error("EXTERNAL_ONLY_CAPABILITY_IDS not found")
  return stringsIn(body)
}

/** The protocols the contract declares executable. */
export function declaredExecutableProtocols(source) {
  const body = source.match(
    /BUILTIN_EXECUTABLE_EXTERNAL_AGENT_PROTOCOLS: readonly BuiltinExecutableExternalAgentProtocol\[\] =\s*\[([\s\S]*?)\]/
  )?.[1]
  if (!body) throw new Error("BUILTIN_EXECUTABLE_EXTERNAL_AGENT_PROTOCOLS not found")
  return stringsIn(body)
}

/** The protocols `manager.ts` actually registers an adapter for. */
export function registeredProtocols(source) {
  return [
    ...stripComments(source).matchAll(/protocolAdapterRegistry\.register\(\s*"([^"]+)"/g),
  ].map((m) => m[1])
}

/** Home-relative roots the Rust launcher grants, as `match → roots`. */
export function rustStateRoots(source) {
  const body = source.match(/pub fn agent_state_writable_roots\([\s\S]*?\n\}\n/)?.[0]
  if (!body) throw new Error("agent_state_writable_roots not found")
  const clean = stripComments(body)
  const roots = new Set()
  // `home.join("a").join("b")` → "a/b"
  for (const chain of clean.matchAll(/home\s*((?:\.join\("[^"]+"\)\s*)+)/g)) {
    const parts = [...chain[1].matchAll(/\.join\("([^"]+)"\)/g)].map((m) => m[1])
    roots.add(parts.join("/"))
  }
  return roots
}

/** Bare commands every shipped preset can spawn. */
export function presetCommands(ecosystem, presets) {
  const commands = new Set()
  for (const source of [ecosystem, presets]) {
    for (const match of stripComments(source).matchAll(/command:\s*"([^"]*)"/g)) {
      if (match[1]) commands.add(match[1])
    }
  }
  return commands
}

/** @returns {string[]} errors */
export function checkCapabilityManifest(manifest, vocabulary, registered) {
  const errors = []
  const declared = new Set(manifest.capabilityIds)

  for (const id of vocabulary) {
    if (!declared.has(id)) errors.push(`${CAPABILITY_MANIFEST}: capabilityIds omits "${id}"`)
  }
  for (const id of declared) {
    if (!vocabulary.includes(id)) {
      errors.push(`${CAPABILITY_MANIFEST}: capabilityIds has unknown id "${id}"`)
    }
  }

  const protocols = Object.keys(manifest.protocols)
  for (const protocol of registered) {
    if (!protocols.includes(protocol)) {
      errors.push(
        `${CAPABILITY_MANIFEST}: no row for "${protocol}", which ${MANAGER_TS} registers an adapter for`
      )
    }
  }
  for (const protocol of protocols) {
    if (!registered.includes(protocol)) {
      errors.push(
        `${CAPABILITY_MANIFEST}: row for "${protocol}", which ${MANAGER_TS} registers no adapter for`
      )
    }
  }

  for (const [protocol, row] of Object.entries(manifest.protocols)) {
    for (const id of vocabulary) {
      const cell = row.capabilities?.[id]
      if (!cell) {
        // Absent reads as unsupported at every call site downstream, which is
        // indistinguishable from a measured refusal. The manifest has to say
        // `unknown` out loud instead.
        errors.push(`${CAPABILITY_MANIFEST}: protocols.${protocol} omits "${id}"`)
        continue
      }
      if (!LEVELS.has(cell.level)) {
        errors.push(`${CAPABILITY_MANIFEST}: protocols.${protocol}.${id} bad level "${cell.level}"`)
      }
      if (cell.evidence === "none" && cell.level !== "unknown") {
        errors.push(
          `${CAPABILITY_MANIFEST}: protocols.${protocol}.${id} claims "${cell.level}" with no evidence`
        )
      }
      if ((cell.level === "unsupported" || cell.level === "equivalent") && !cell.reasonKey) {
        errors.push(`${CAPABILITY_MANIFEST}: protocols.${protocol}.${id} needs a reasonKey`)
      }
    }
  }

  for (const [presetId, entry] of Object.entries(manifest.presetRefinements ?? {})) {
    if (!protocols.includes(entry.protocol)) {
      errors.push(
        `${CAPABILITY_MANIFEST}: preset "${presetId}" refines unknown protocol "${entry.protocol}"`
      )
    }
  }

  return errors
}

/** @returns {string[]} errors */
export function checkSecurityPolicyParity(policy, rustPresets, rustSandbox, commands) {
  const errors = []

  const compare = (label, fromJson, fromRust) => {
    const json = new Set(fromJson)
    const rust = new Set(fromRust)
    for (const value of json) {
      if (!rust.has(value))
        errors.push(`${label}: "${value}" is in ${SECURITY_POLICY} but not in Rust`)
    }
    for (const value of rust) {
      if (!json.has(value))
        errors.push(`${label}: "${value}" is in Rust but not in ${SECURITY_POLICY}`)
    }
  }

  compare(
    "binaryAllowlist",
    policy.binaryAllowlist.commands,
    rustStrArray(rustPresets, "BINARY_ALLOWLIST")
  )
  compare(
    "npxPackageAllowlist",
    policy.npxPackageAllowlist.packages,
    rustStrArray(rustPresets, "NPX_PACKAGE_ALLOWLIST")
  )

  const jsonRoots = new Set(policy.agentStateWritableRoots.rules.flatMap((rule) => rule.roots))
  const rustRoots = rustStateRoots(rustSandbox)
  for (const root of jsonRoots) {
    if (!rustRoots.has(root)) {
      errors.push(`agentStateWritableRoots: "${root}" is in ${SECURITY_POLICY} but not in Rust`)
    }
  }
  for (const root of rustRoots) {
    if (!jsonRoots.has(root)) {
      errors.push(`agentStateWritableRoots: "${root}" is in Rust but not in ${SECURITY_POLICY}`)
    }
  }

  // A binary that neither a preset spawns nor `manualOnly` justifies is attack
  // surface the headless RPC exposes and no Cognia code path can ask for —
  // which is precisely what `cline` was. The `manualOnly` escape hatch is not a
  // loophole: it costs a written reason, which is the thing that was missing.
  const manualOnly = policy.binaryAllowlist.manualOnly ?? {}
  for (const binary of policy.binaryAllowlist.commands) {
    if (commands.has(binary)) continue
    const reason = manualOnly[binary]
    if (!reason) {
      errors.push(
        `binaryAllowlist: "${binary}" is reachable from no shipped preset — remove it, or add it to ` +
          `binaryAllowlist.manualOnly with a reason`
      )
    } else if (reason.trim().length < 20) {
      errors.push(`binaryAllowlist.manualOnly."${binary}": the reason must actually explain why`)
    }
  }
  for (const binary of Object.keys(manualOnly)) {
    if (!policy.binaryAllowlist.commands.includes(binary)) {
      errors.push(`binaryAllowlist.manualOnly: stale entry "${binary}" is not allowlisted`)
    }
  }
  // …and the converse: a preset whose command is not allowlisted cannot spawn
  // headlessly, which is exactly how `claude-agent-acp` was broken.
  for (const command of commands) {
    if (command === "npx") continue
    if (!policy.binaryAllowlist.commands.includes(command)) {
      errors.push(
        `binaryAllowlist: preset command "${command}" is not allowlisted, so a headless spawn is refused`
      )
    }
  }

  return errors
}

export function runChecks() {
  const manifest = readJson(CAPABILITY_MANIFEST)
  const policy = readJson(SECURITY_POLICY)
  const contract = read(CONTRACT_TS)
  const vocabulary = [
    ...specCapabilityIds(read(EXECUTION_TS)),
    ...externalOnlyCapabilityIds(contract),
  ]
  const registered = registeredProtocols(read(MANAGER_TS))
  const declaredExecutable = declaredExecutableProtocols(contract)

  const errors = []

  for (const protocol of registered) {
    if (!declaredExecutable.includes(protocol)) {
      errors.push(
        `${CONTRACT_TS}: BUILTIN_EXECUTABLE_EXTERNAL_AGENT_PROTOCOLS omits "${protocol}", which ${MANAGER_TS} registers`
      )
    }
  }
  for (const protocol of declaredExecutable) {
    if (!registered.includes(protocol)) {
      errors.push(
        `${CONTRACT_TS}: BUILTIN_EXECUTABLE_EXTERNAL_AGENT_PROTOCOLS lists "${protocol}", which ${MANAGER_TS} never registers`
      )
    }
  }

  errors.push(...checkCapabilityManifest(manifest, vocabulary, registered))
  errors.push(
    ...checkSecurityPolicyParity(
      policy,
      read(RUST_PRESETS),
      read(RUST_SANDBOX),
      presetCommands(read(ECOSYSTEM_TS), read(PRESETS_TS))
    )
  )

  return errors
}

if (process.argv[1] && process.argv[1].endsWith("check-agent-capabilities.mjs")) {
  const errors = runChecks()
  if (errors.length > 0) {
    console.error("[agent-capabilities] external-agent SSOT is out of sync:\n")
    for (const error of errors) console.error(`  • ${error}`)
    console.error(
      "\n  protocol/agent-capabilities.json and protocol/external-agent-security-policy.json\n" +
        "  are the sources. Update them first, then the Rust literals that mirror them.\n"
    )
    process.exit(1)
  }
  console.log("[agent-capabilities] ok")
}
