#!/usr/bin/env node
/**
 * Gate: the sidecar's per-adapter capability table must agree with the
 * renderer's, for every capability a host command actually gates on.
 *
 * There are two tables saying what a runtime can do:
 *
 *   • `RUNTIME_CAPABILITIES` — `lib/ai/agent/execution/resolve-agent-execution-spec.ts`.
 *     Frozen into each `ResolvedAgentExecutionSpec.capabilities.effective`.
 *   • `ADAPTER_CAPABILITIES` — `sidecar/dispatch/runtime-adapter.mjs`. Consulted
 *     at command time, and its own comment calls itself a mirror of the first.
 *
 * They were not in fact mirrors, and the way that surfaced is worth recording:
 * `COMMAND_CAPABILITIES.steer` gated the steer command on the `steer`
 * capability, which the claude-agent-sdk rail was missing from BOTH tables —
 * even though `routeSteer()` implements steering for exactly that rail and
 * refuses every other provider. So a session carrying a frozen spec got a
 * `capability_error` for steering, while the same session steered fine through
 * the live control path. Fail-closed firing on a capability the runtime has is
 * worse than the gap it was protecting against.
 *
 * The sidecar table is deliberately a SUBSET — it only lists command-relevant
 * ids. So the invariant is not "equal", it is: for every capability some
 * command gates on, the two tables must agree per adapter. Anything else is a
 * command that either wrongly rejects or wrongly admits.
 *
 * Usage: pnpm audit:adapter-capabilities
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const TS_PATH = join(
  REPO_ROOT,
  "lib",
  "ai",
  "agent",
  "execution",
  "resolve-agent-execution-spec.ts"
)
const SIDECAR_PATH = join(REPO_ROOT, "sidecar", "dispatch", "runtime-adapter.mjs")
const CONTROL_PATH = join(REPO_ROOT, "sidecar", "dispatch", "control.mjs")
const CONTRACT_PATH = join(REPO_ROOT, "packages", "agent-config-types", "src", "agent-execution.ts")

/** Adapters both tables describe. `external` has no sidecar dispatcher. */
export const SHARED_ADAPTERS = ["claude-agent-sdk", "ai-sdk"]

/**
 * Both tables are heavily commented — the comments are how the non-obvious
 * entries justify themselves — and a comment that quotes a capability id (or
 * any other word) would otherwise be read as a table entry. Strip them first.
 */
const stripComments = (block) => block.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")

const stringsIn = (block) =>
  new Set([...stripComments(block).matchAll(/"([^"]+)"/g)].map((m) => m[1]))

/**
 * `RUNTIME_CAPABILITIES` as `{ adapter: Set<capability> }`.
 *
 * @param {string} source
 */
export function extractRuntimeCapabilities(source) {
  const body = source.match(
    /RUNTIME_CAPABILITIES: Record<AgentRuntimeAdapterId, readonly AgentCapabilityId\[\]> = \{([\s\S]*?)\n\}/
  )?.[1]
  if (!body) throw new Error("resolve-agent-execution-spec.ts: `RUNTIME_CAPABILITIES` not found")
  return parseAdapterBlocks(body, /(?:"([^"]+)"|(\w[\w-]*)):\s*\[([\s\S]*?)\n {2}\]/g)
}

/**
 * `ADAPTER_CAPABILITIES` as `{ adapter: Set<capability> }`.
 *
 * @param {string} source
 */
export function extractAdapterCapabilities(source) {
  const body = source.match(/export const ADAPTER_CAPABILITIES = \{([\s\S]*?)\n\}/)?.[1]
  if (!body) throw new Error("runtime-adapter.mjs: `ADAPTER_CAPABILITIES` not found")
  return parseAdapterBlocks(body, /(?:"([^"]+)"|(\w[\w-]*)):\s*new Set\(\[([\s\S]*?)\n {2}\]\)/g)
}

function parseAdapterBlocks(body, pattern) {
  /** @type {Record<string, Set<string>>} */
  const out = {}
  for (const m of body.matchAll(pattern)) out[m[1] ?? m[2]] = stringsIn(m[3])
  return out
}

/**
 * `COMMAND_CAPABILITIES` as `{ command: capability }`.
 *
 * @param {string} source
 */
export function extractCommandCapabilities(source) {
  const body = source.match(/export const COMMAND_CAPABILITIES = \{([\s\S]*?)\n\}/)?.[1]
  if (!body) throw new Error("runtime-adapter.mjs: `COMMAND_CAPABILITIES` not found")
  return Object.fromEntries([...body.matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]))
}

/** `AGENT_CAPABILITY_IDS` from the contract. */
export function extractCapabilityIds(source) {
  const body = source.match(
    /AGENT_CAPABILITY_IDS: readonly AgentCapabilityId\[\] = \[([\s\S]*?)\n\]/
  )?.[1]
  if (!body) throw new Error("agent-execution.ts: `AGENT_CAPABILITY_IDS` not found")
  return stringsIn(body)
}

/**
 * @param {{
 *   runtime: Record<string, Set<string>>,
 *   adapter: Record<string, Set<string>>,
 *   commands: Record<string, string>,
 *   capabilityIds: Set<string>,
 *   controlCapabilities?: Record<string, string>,
 * }} input
 * @returns {string[]}
 */
export function verify({ runtime, adapter, commands, capabilityIds, controlCapabilities }) {
  const errors = []

  for (const [table, name] of [
    [runtime, "RUNTIME_CAPABILITIES"],
    [adapter, "ADAPTER_CAPABILITIES"],
  ]) {
    for (const [id, caps] of Object.entries(table)) {
      for (const cap of caps) {
        if (!capabilityIds.has(cap)) {
          errors.push(`${name}.${id}: "${cap}" is not a known AgentCapabilityId`)
        }
      }
    }
  }

  for (const [command, cap] of Object.entries(commands)) {
    if (!capabilityIds.has(cap)) {
      errors.push(`COMMAND_CAPABILITIES.${command}: "${cap}" is not a known AgentCapabilityId`)
      continue
    }

    // The check that would have caught the `steer` bug: both tables agreed —
    // by both omitting it — while the command gated on it anyway, so steering
    // was rejected on every dispatchable adapter. A gated capability no adapter
    // has is a command that can only ever fail.
    if (!SHARED_ADAPTERS.some((id) => adapter[id]?.has(cap) || runtime[id]?.has(cap))) {
      errors.push(
        `COMMAND_CAPABILITIES.${command} gates on "${cap}", which no dispatchable adapter ` +
          `declares — the command can only ever return capability_error`
      )
      continue
    }

    for (const id of SHARED_ADAPTERS) {
      const inRuntime = runtime[id]?.has(cap) ?? false
      const inAdapter = adapter[id]?.has(cap) ?? false
      if (inRuntime === inAdapter) continue

      errors.push(
        inRuntime
          ? `${id}: the resolver says "${cap}" is effective but the sidecar table omits it, ` +
              `so \`${command}\` is rejected on a runtime that supports it`
          : `${id}: the sidecar serves \`${command}\` via "${cap}" but the resolver never puts ` +
              `it in \`capabilities.effective\`, so the spec under-reports what the session can do`
      )
    }
  }

  // The sidecar table is a subset by design, but only of ids the resolver knows
  // about — an id it invents is unreachable from any spec.
  for (const id of SHARED_ADAPTERS) {
    for (const cap of adapter[id] ?? []) {
      if (!runtime[id]?.has(cap)) {
        errors.push(`${id}: ADAPTER_CAPABILITIES has "${cap}", absent from RUNTIME_CAPABILITIES`)
      }
    }
  }

  // Control methods are checked more weakly than host commands, on purpose.
  // A capability id can mean two different things across rails — `mcp` means
  // "has MCP tools" on the ai-sdk rail and "can introspect MCP servers" on the
  // Claude one — so demanding the two tables agree per adapter would flag a
  // difference that is real. What must hold is only that SOME dispatchable
  // adapter declares it: a control gated on a capability nobody has is a
  // control that can only ever return `capability_error`.
  for (const [method, cap] of Object.entries(controlCapabilities ?? {})) {
    if (!capabilityIds.has(cap)) {
      errors.push(
        `CONTROL_METHOD_CAPABILITIES.${method}: "${cap}" is not a known AgentCapabilityId`
      )
      continue
    }
    if (!SHARED_ADAPTERS.some((id) => adapter[id]?.has(cap))) {
      errors.push(
        `CONTROL_METHOD_CAPABILITIES.${method} gates on "${cap}", which no adapter declares — ` +
          `the control can only ever return capability_error`
      )
    }
  }

  return errors
}

/** `CONTROL_METHOD_CAPABILITIES` as `{ method: capability }`. */
export function extractControlCapabilities(source) {
  const body = source.match(/export const CONTROL_METHOD_CAPABILITIES = \{([\s\S]*?)\n\}/)?.[1]
  if (!body) throw new Error("control.mjs: `CONTROL_METHOD_CAPABILITIES` not found")
  return Object.fromEntries(
    [...body.matchAll(/(?:"([^"]+)"|([A-Za-z_]\w*)):\s*"([^"]+)"/g)].map((m) => [
      m[1] ?? m[2],
      m[3],
    ])
  )
}

export function loadAndVerify(read = (p) => readFileSync(p, "utf8")) {
  const sidecar = read(SIDECAR_PATH)
  return verify({
    runtime: extractRuntimeCapabilities(read(TS_PATH)),
    adapter: extractAdapterCapabilities(sidecar),
    commands: extractCommandCapabilities(sidecar),
    capabilityIds: extractCapabilityIds(read(CONTRACT_PATH)),
    controlCapabilities: extractControlCapabilities(read(CONTROL_PATH)),
  })
}

export function main() {
  const errors = loadAndVerify()
  if (errors.length) {
    console.error("[adapter-capabilities] the two capability tables disagree:")
    for (const e of errors) console.error(`  - ${e}`)
    console.error(
      "\n  Both tables must agree for every capability a command gates on.\n" +
        "  Disagreement means a host command either rejects a runtime that\n" +
        "  supports it, or serves one whose frozen spec never claimed it."
    )
    return 1
  }

  const sidecar = readFileSync(SIDECAR_PATH, "utf8")
  const commands = Object.keys(extractCommandCapabilities(sidecar)).length
  console.log(
    `[adapter-capabilities] OK — ${commands} gated command(s) agree across ` +
      `${SHARED_ADAPTERS.length} adapters`
  )
  return 0
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-adapter-capability-parity.mjs")
) {
  process.exit(main())
}
