#!/usr/bin/env node
/**
 * Gate: every companion command name obeys one grammar (ADR-0175).
 *
 *   <resource>[.<sub>...].<verb>
 *
 * The resource must be a path in protocol/companion-resources.json. The verb
 * is one entry of protocol/companion-verbs.json, optionally followed by a
 * qualifier (`set_bounds`, `read_chunk`, `list_pending`). Refused verbs
 * (`kill`, `abort`, `state`, ...) name their replacement so the failure says
 * what to write instead.
 *
 * Why a gate and not a review: the old surface grew to 1,328 names with the
 * verb at the front (`get_close_behavior`), at the back
 * (`automation_settings_get`), or nowhere (`browser_pages`); one board under
 * two prefixes (`agent_task_*` / `team_task_*`); four words for stop; and
 * `status` next to `state` with no rule. None of that failed anything.
 *
 * Rules, each with a stable prefix in its message:
 *   R1 name == resource + "." + verb            (report until the B5 rename cut)
 *   R2 resource in tree, verb in vocabulary, refused verbs name a replacement
 *   R3 list verbs paginate by token; byte-range only on read/write heads
 *   R4 request schema: object root, additionalProperties:false, camelCase
 *      properties, no limit/offset/cursor/before outside byte-range
 *      (a legacy paging name on a page-token command fails since B3, the
 *      rest report until the B5 casing cut)
 *   R5 longRunning commands return the Operation shape (report until B4
 *      registers the Operation output, no command declares longRunning yet)
 *   R6 arm is unique and has a dispatch arm in exactly one rpc source
 *   R7 no renamed old name survives as a string literal in client code
 *                                                (report until the rename cut)
 *   R8 policy invariants: mutation => idempotency required; client and
 *      service targets are internal-only; capability non-empty
 *
 * Escape hatch for R7: `// command-rename-exempt: <reason>` on the line or
 * the line above. A bare marker is itself a failure.
 *
 * Usage: pnpm audit:command-grammar
 */

import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

export const PROTOCOL = {
  commands: "protocol/companion-commands.json",
  resources: "protocol/companion-resources.json",
  verbs: "protocol/companion-verbs.json",
  renames: "protocol/companion-command-renames.json",
  requestSchemas: "protocol/companion-request-schemas.json",
}

/** Every file whose `match name { "literal" => ... }` arms answer a command. */
export const DISPATCH_SOURCES = [
  "src-tauri/src/companion_api/rpc.rs",
  "src-tauri/src/companion_api/rpc/chat.rs",
  "src-tauri/src/companion_api/rpc/codex_app.rs",
  "src-tauri/src/companion_api/rpc/native_tools.rs",
  "src-tauri/src/companion_api/rpc/data_sync.rs",
  "src-tauri/src/companion_api/rpc/service_plane.rs",
  "src-tauri/src/companion_api/rpc/gateway_plane.rs",
  "src-tauri/src/companion_api/rpc/source_control.rs",
  "src-tauri/src/companion_api/rpc/filesystem.rs",
  "src-tauri/src/companion_api/rpc/terminal.rs",
  "src-tauri/src/companion_api/rpc/sftp.rs",
  "src-tauri/src/companion_api/rpc/media.rs",
  "src-tauri/src/companion_api/rpc/host_state.rs",
  "src-tauri/src/companion_api/rpc/plugins.rs",
  "src-tauri/src/companion_api/rpc/diagnostics.rs",
  "src-tauri/src/companion_api/rpc/host_admin.rs",
  "src-tauri/src/companion_api/rpc/environment.rs",
  // Two families dispatch outside rpc/: the browser gateway keys its arms on
  // the same literals, and SFTP is served by its own service module.
  "src-tauri/src/companion_api/browser_gateway.rs",
  "src-tauri/src/sftp_service.rs",
]

/** Directories scanned for surviving old-name literals (R7). */
export const CLIENT_SCAN_DIRS = [
  "app",
  "components",
  "hooks",
  "stores",
  "lib",
  "cli",
  "packages",
  "plugins",
]

export const SEGMENT = /^[a-z][a-z0-9_]*$/
const CAMEL = /^[a-z][a-zA-Z0-9]*$/
const PAGING_PARAMS = new Set([
  "limit",
  "offset",
  "cursor",
  "before",
  "page",
  "per_page",
  "perPage",
])
const EXEMPT_RE = /\/\/\s*command-rename-exempt:(.*)$/

export function wireName(resource, verb) {
  return `${resource}.${verb}`
}

export function resourceExists(tree, path) {
  let node = { children: tree }
  for (const seg of path.split(".")) {
    node = node.children?.[seg]
    if (!node) return false
  }
  return true
}

/** The vocabulary verb a `verb` segment resolves to, or null. */
export function resolveVerb(vocabulary, verb) {
  if (vocabulary.has(verb)) return verb
  const head = verb.split("_")[0]
  return vocabulary.has(head) ? head : null
}

export function vocabularyOf(verbs) {
  return new Set([...Object.keys(verbs.standard ?? {}), ...Object.keys(verbs.custom ?? {})])
}

/**
 * Pure audit over already-loaded inputs. Returns { failures, reports }, each a
 * list of strings prefixed by the rule id.
 */
export function auditContract({
  commands,
  resources,
  verbs,
  renames,
  requestSchemas,
  dispatchSources,
  clientLiteralHits,
}) {
  const failures = []
  const reports = []
  const vocabulary = vocabularyOf(verbs)
  const refused = verbs.refused ?? {}
  const exceptions = verbs.exceptions ?? {}
  // Old names never contain a dot, so the first dotted wire name marks the
  // rename cut as applied and every straggler after that is a failure.
  const applied = commands.some((c) => typeof c.name === "string" && c.name.includes("."))

  // Vocabulary hygiene: every verb has a definition line.
  for (const [group, table] of [
    ["standard", verbs.standard ?? {}],
    ["custom", verbs.custom ?? {}],
  ]) {
    for (const [verb, definition] of Object.entries(table)) {
      if (!SEGMENT.test(verb)) failures.push(`R2 ${group} verb "${verb}" is not snake_case`)
      if (typeof definition !== "string" || definition.trim().length === 0) {
        failures.push(`R2 ${group} verb "${verb}" has no definition`)
      }
      if (refused[verb]) failures.push(`R2 verb "${verb}" is both defined and refused`)
    }
  }

  const arms = new Map()
  const names = new Set()
  for (const c of commands) {
    const label = c.name
    // R1
    const expected = wireName(c.resource, c.verb)
    if (c.name !== expected) {
      ;(applied ? failures : reports).push(`R1 ${label}: wire name should be ${expected}`)
    }
    if (names.has(c.name)) failures.push(`R1 ${label}: duplicate wire name`)
    names.add(c.name)

    // R2
    if (typeof c.resource !== "string" || !c.resource.split(".").every((s) => SEGMENT.test(s))) {
      failures.push(`R2 ${label}: resource "${c.resource}" is not a dotted snake_case path`)
    } else if (!resourceExists(resources, c.resource)) {
      failures.push(
        `R2 ${label}: resource "${c.resource}" is not in protocol/companion-resources.json`
      )
    }
    if (typeof c.verb !== "string" || !SEGMENT.test(c.verb)) {
      failures.push(`R2 ${label}: verb "${c.verb}" is not snake_case`)
    } else {
      const head = c.verb.split("_")[0]
      const top = c.resource?.split(".")[0]
      const refusedRow = refused[c.verb] ?? refused[head]
      const excepted =
        (exceptions[top] ?? []).includes(c.verb) || (exceptions[top] ?? []).includes(head)
      if (refusedRow && !excepted) {
        failures.push(
          `R2 ${label}: verb "${c.verb}" is refused; write "${refusedRow.replacement}"${refusedRow.note ? ` (${refusedRow.note})` : ""}`
        )
      } else if (!excepted && !resolveVerb(vocabulary, c.verb)) {
        failures.push(`R2 ${label}: verb "${c.verb}" is not in protocol/companion-verbs.json`)
      }
    }

    // R3
    const head = typeof c.verb === "string" ? c.verb.split("_")[0] : ""
    const isList = c.verb === "list" || (typeof c.verb === "string" && c.verb.startsWith("list_"))
    if (isList && c.pagination !== "page-token")
      failures.push(`R3 ${label}: list verbs paginate by token`)
    if (c.pagination === "byte-range" && !["read", "write", "upload", "download"].includes(head)) {
      failures.push(`R3 ${label}: byte-range pagination belongs to read/write verbs`)
    }
    if (c.pagination === "page-token" && !isList)
      reports.push(`R3 ${label}: page-token on a non-list verb`)

    // R4 (request schema shape)
    const schema = requestSchemas?.[c.name]
    if (schema) {
      const sink = reports
      if (schema.type !== "object") sink.push(`R4 ${label}: request root is not an object`)
      if (schema.additionalProperties !== false)
        sink.push(`R4 ${label}: request root allows additional properties`)
      for (const prop of Object.keys(schema.properties ?? {})) {
        if (!CAMEL.test(prop)) sink.push(`R4 ${label}: property "${prop}" is not camelCase`)
        if (PAGING_PARAMS.has(prop) && c.pagination !== "byte-range") {
          // A page-token command that still names a legacy parameter would
          // publish two paging vocabularies at once, so that fails (B3). On
          // a command that does not page yet it stays a report until its arm
          // migrates.
          const target = c.pagination === "page-token" ? failures : sink
          target.push(`R4 ${label}: "${prop}" is not a paging parameter; use pageSize/pageToken`)
        }
      }
      if (c.pagination === "page-token") {
        const props = schema.properties ?? {}
        if (!props.pageSize || !props.pageToken)
          sink.push(`R4 ${label}: page-token commands take pageSize and pageToken`)
      }
    }

    // R5
    if (c.longRunning && c.outputSchema !== "#/$defs/Operation") {
      reports.push(`R5 ${label}: longRunning commands return #/$defs/Operation`)
    }

    // R6
    if (typeof c.arm !== "string" || !SEGMENT.test(c.arm)) {
      failures.push(`R6 ${label}: arm "${c.arm}" is not snake_case`)
    } else {
      if (arms.has(c.arm))
        failures.push(`R6 ${label}: arm "${c.arm}" is also the arm of ${arms.get(c.arm)}`)
      arms.set(c.arm, c.name)
      if (c.target !== "client" && dispatchSources) {
        const files = dispatchSources
          .filter(({ source }) => hasArm(source, c.arm))
          .map(({ path }) => path)
        if (files.length === 0)
          failures.push(`R6 ${label}: arm "${c.arm}" has no dispatch arm in any rpc source`)
        if (files.length > 1)
          reports.push(
            `R6 ${label}: arm "${c.arm}" appears in ${files.length} rpc sources (${files.join(", ")})`
          )
      }
    }

    // R8
    if (typeof c.capability !== "string" || c.capability.length === 0)
      failures.push(`R8 ${label}: capability is empty`)
    if (c.operation !== "read" && c.idempotency !== "required")
      failures.push(`R8 ${label}: mutations require idempotency`)
    if (
      (c.target === "client" || c.target === "service") &&
      !(c.transports?.length === 1 && c.transports[0] === "internal")
    ) {
      failures.push(`R8 ${label}: ${c.target} commands are internal-only`)
    }
  }

  // Renames map consistency + R7
  const byName = new Map(commands.map((c) => [c.name, c]))
  for (const [old, row] of Object.entries(renames ?? {})) {
    if (applied) {
      if (!names.has(row.to))
        failures.push(`R7 rename ${old} -> ${row.to}: target is not a command`)
      if (names.has(old)) failures.push(`R7 ${old}: old name is still a command`)
    } else {
      // Before the cut the map is a promise: every old name is a live command
      // and its target is exactly what that command's resource and verb spell.
      const current = byName.get(old)
      if (!current) failures.push(`R7 rename ${old}: not a command`)
      else if (row.to !== wireName(current.resource, current.verb)) {
        failures.push(
          `R7 rename ${old} -> ${row.to}: disagrees with resource.verb (${wireName(current.resource, current.verb)})`
        )
      }
    }
    if (row.merge && !(row.merge in renames))
      failures.push(`R7 rename ${old}: merge target ${row.merge} is not in the renames map`)
  }
  if (clientLiteralHits) {
    for (const hit of clientLiteralHits) {
      const line = `R7 ${hit.file}:${hit.line}: "${hit.command}" is a renamed name; use ${renames[hit.command]?.to}`
      if (hit.exempt === "bare")
        failures.push(`R7 ${hit.file}:${hit.line}: command-rename-exempt needs a reason`)
      else if (hit.exempt === "valid") continue
      else (applied ? failures : reports).push(line)
    }
  }

  return { failures, reports, applied }
}

/**
 * Whether `source` dispatches `arm`: a match arm (`"arm" =>`, `| "arm"`) or
 * an explicit comparison (`name == "arm"`), which is how the browser gateway
 * routes its session commands.
 */
export function hasArm(source, arm) {
  const escaped = arm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(
    `"${escaped}"\\s*(?:=>|\\|)|\\|\\s*"${escaped}"\\s*(?:=>|\\||\\n)|==\\s*"${escaped}"`
  ).test(source)
}

/** Scan one client source for old-name literals in invoke()/call() positions. */
export function scanClientSource(relPath, src, oldNames) {
  const hits = []
  const lines = src.split("\n")
  const re = /\b(?:invoke|call)\s*(?:<[^>()]*>)?\s*\(\s*(["'`])([a-z][a-z0-9_]*)\1/g
  for (const m of src.matchAll(re)) {
    const command = m[2]
    if (!oldNames.has(command)) continue
    const line = src.slice(0, m.index).split("\n").length
    let exempt = "none"
    for (const idx of [line - 1, line - 2]) {
      const em = idx >= 0 ? lines[idx].match(EXEMPT_RE) : null
      if (em) exempt = em[1].trim() === "" ? "bare" : "valid"
    }
    hits.push({ file: relPath, line, command, exempt })
  }
  return hits
}

function listClientFiles() {
  const cmd = `git -C "${REPO_ROOT}" ls-files ${CLIENT_SCAN_DIRS.map((d) => `"${d}"`).join(" ")}`
  return execSync(cmd, { encoding: "utf8" })
    .split("\n")
    .filter(
      (p) =>
        /\.(ts|tsx|mjs)$/.test(p) &&
        !/\.(test|stories)\.(ts|tsx|mjs)$/.test(p) &&
        !p.includes("/generated/")
    )
    .filter((p) => existsSync(resolve(REPO_ROOT, p)))
}

export function loadAndAudit() {
  const read = (p) => JSON.parse(readFileSync(resolve(REPO_ROOT, p), "utf8"))
  const commands = read(PROTOCOL.commands).commands
  const resources = read(PROTOCOL.resources).resources
  const verbs = read(PROTOCOL.verbs)
  const renames = read(PROTOCOL.renames).renames
  const requestSchemas = read(PROTOCOL.requestSchemas).commands
  const dispatchSources = DISPATCH_SOURCES.filter((p) => existsSync(resolve(REPO_ROOT, p))).map(
    (p) => ({
      path: p,
      source: readFileSync(resolve(REPO_ROOT, p), "utf8"),
    })
  )
  const oldNames = new Set(Object.keys(renames).filter((old) => renames[old].to !== old))
  const clientLiteralHits = []
  for (const file of listClientFiles()) {
    clientLiteralHits.push(
      ...scanClientSource(file, readFileSync(resolve(REPO_ROOT, file), "utf8"), oldNames)
    )
  }
  return auditContract({
    commands,
    resources,
    verbs,
    renames,
    requestSchemas,
    dispatchSources,
    clientLiteralHits,
  })
}

function main() {
  const { failures, reports, applied } = loadAndAudit()
  const byRule = (list) => {
    const counts = {}
    for (const item of list) counts[item.slice(0, 2)] = (counts[item.slice(0, 2)] ?? 0) + 1
    return Object.entries(counts)
      .map(([rule, n]) => `${rule}=${n}`)
      .join(" ")
  }
  if (reports.length > 0) {
    console.log(
      `[command-grammar] ${reports.length} report-only finding(s) (${byRule(reports)}); rename cut ${applied ? "applied" : "not yet applied"}`
    )
    if (process.env.COMMAND_GRAMMAR_VERBOSE) for (const r of reports) console.log(`  ~ ${r}`)
  }
  if (failures.length > 0) {
    console.error(`[command-grammar] ${failures.length} failure(s) (${byRule(failures)}):`)
    for (const f of failures.slice(0, 200)) console.error(`  - ${f}`)
    if (failures.length > 200) console.error(`  ... ${failures.length - 200} more`)
    return 1
  }
  console.log(`[command-grammar] OK`)
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
