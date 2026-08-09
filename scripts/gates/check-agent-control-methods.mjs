#!/usr/bin/env node
/**
 * Gate: the live session-control surface must agree across all four places it
 * is declared, and each declaration must match `protocol/agent-control-methods.json`.
 *
 * Why: the same eight method names are hand-written in four files, in three
 * languages —
 *   1. `SessionControlMethod`            packages/agent-config-types/src/index.ts
 *   2. `CONTROL_METHODS`                 sidecar/dispatch/control.mjs
 *   3. `is_allowed_control_method`       src-tauri/src/claude/commands.rs
 *   4. `allows_only_known_control_methods` (the Rust test re-types them again)
 * — and the SDK-parity work adds 17 more. Four hand-maintained copies of a
 * growing list is four drift sources; the sibling `companion-commands.json`
 * already proved the manifest-plus-gate shape works here.
 *
 * Three things this catches that a plain string diff would not:
 *
 * - **The `steer` trap.** `steer` sits on the control allowlist but is NOT an
 *   SDK `Query` method — the host intercepts it in `routeSteer()`. Anyone
 *   regenerating the allowlist from `sdk.d.ts` would silently delete steering.
 *   The manifest marks it `kind: "host"` and the gate asserts it is absent
 *   from the SDK surface.
 * - **Phantom SDK methods.** Anything marked `kind: "sdk"` must actually exist
 *   in `protocol/agent-sdk-surface.json`, so a typo or a method the SDK
 *   dropped fails here rather than at runtime as `unknown_method`.
 * - **Premature allowlisting.** A method still marked `planned` must not
 *   appear in any runtime site. Allowlisting a control before it is wired is
 *   the "built but dormant" failure in its most dangerous form: the call
 *   reaches a live `Query` object.
 *
 * Usage: pnpm audit:agent-control-methods
 */

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

const SITES = {
  "packages/agent-config-types/src/index.ts": extractTsUnion,
  "sidecar/dispatch/control.mjs": extractSidecarSet,
  "src-tauri/src/claude/commands.rs": extractRustAllowlist,
  "src-tauri/src/claude/commands.rs::test": extractRustTestList,
}

/** `export type SessionControlMethod = | "a" | "b"` */
export function extractTsUnion(source) {
  const m = source.match(/export type SessionControlMethod =([\s\S]*?)(?:\n\n|\n\/\*)/)
  if (!m) throw new Error("could not locate `export type SessionControlMethod`")
  return new Set([...m[1].matchAll(/"([A-Za-z_][\w]*)"/g)].map((x) => x[1]))
}

/** `export const CONTROL_METHODS = new Set([ ... ])` */
export function extractSidecarSet(source) {
  const m = source.match(/export const CONTROL_METHODS = new Set\(\[([\s\S]*?)\]\)/)
  if (!m) throw new Error("could not locate `CONTROL_METHODS`")
  return new Set([...m[1].matchAll(/"([A-Za-z_][\w]*)"/g)].map((x) => x[1]))
}

/** `pub fn is_allowed_control_method(...) { matches!(method, "a" | "b") }` */
export function extractRustAllowlist(source) {
  const m = source.match(/pub fn is_allowed_control_method[\s\S]*?matches!\(([\s\S]*?)\n {4}\)/)
  if (!m) throw new Error("could not locate `is_allowed_control_method`")
  return new Set([...m[1].matchAll(/"([A-Za-z_][\w]*)"/g)].map((x) => x[1]))
}

/**
 * The Rust test's own copy. It also carries a deliberate NEGATIVE list
 * (`"close"`, `"__proto__"`, …) asserting those are rejected, so only the
 * positive array is read.
 */
export function extractRustTestList(source) {
  const m = source.match(
    /fn allows_only_known_control_methods\(\)[\s\S]*?for \w+ in \[([\s\S]*?)\n {8}\]/
  )
  if (!m) throw new Error("could not locate `allows_only_known_control_methods` positive list")
  return new Set([...m[1].matchAll(/"([A-Za-z_][\w]*)"/g)].map((x) => x[1]))
}

/**
 * `controlArgs`'s per-method `case` bodies as `{ method: [paramName, …] }`.
 *
 * Reads the `p.<name>` reads inside each `case`, in order — that IS the
 * positional argument list the SDK receives. Methods that fall through to the
 * no-arg `default` are simply absent.
 */
export function extractControlArgs(source) {
  const body = source.match(/export function controlArgs\(method, params\) \{([\s\S]*?)\n\}/)?.[1]
  if (!body) throw new Error("control.mjs: could not locate `controlArgs`")
  /** @type {Record<string, string[]>} */
  const out = {}
  // Each block runs from one `case "x":` to the next `case`/`default`.
  const blocks = [...body.matchAll(/case "([A-Za-z_]\w*)":([\s\S]*?)(?=\n {4}(?:case |default:))/g)]
  for (const [, name, block] of blocks) {
    out[name] = [...block.matchAll(/\bp\.([A-Za-z_]\w*)/g)].map((m) => m[1])
  }
  return out
}

// ---- session-api sites ---------------------------------------------------
//
// The `session_api` frame has its own five declaration sites, for the same
// reason the control frame does. The stakes are higher here: five of the
// eleven methods rewrite a user's transcripts and one deletes them, so a name
// that drifts onto an allowlist is data loss rather than an `unknown_method`.

/** `export type SessionApiMethod = | "a" | "b"` */
export function extractSessionApiUnion(source) {
  const m = source.match(/export type SessionApiMethod =([\s\S]*?)(?:\n\n|\n\/\*)/)
  if (!m) throw new Error("could not locate `export type SessionApiMethod`")
  return new Set([...m[1].matchAll(/"([A-Za-z_][\w]*)"/g)].map((x) => x[1]))
}

/** `export const SESSION_API_METHODS = { name: { mutates, store }, … }` */
export function extractSessionApiSpecs(source) {
  const body = source.match(/export const SESSION_API_METHODS = \{([\s\S]*?)\n\}/)?.[1]
  if (!body) throw new Error("session-api.mjs: could not locate `SESSION_API_METHODS`")
  /** @type {Record<string, { mutates: boolean, store: boolean }>} */
  const out = {}
  for (const [, name, spec] of body.matchAll(/(\w+):\s*\{([^}]*)\}/g)) {
    out[name] = {
      mutates: /mutates:\s*true/.test(spec),
      store: /store:\s*true/.test(spec),
    }
  }
  return out
}

/** `pub fn is_allowed_session_api_method(...) { matches!(method, "a" | "b") }` */
export function extractRustSessionApiAllowlist(source) {
  const m = source.match(/pub fn is_allowed_session_api_method[\s\S]*?matches!\(([\s\S]*?)\n {4}\)/)
  if (!m) throw new Error("could not locate `is_allowed_session_api_method`")
  return new Set([...m[1].matchAll(/"([A-Za-z_][\w]*)"/g)].map((x) => x[1]))
}

/** The Rust test's own positive copy (it also carries a negative list). */
export function extractRustSessionApiTestList(source) {
  const m = source.match(
    /fn allows_only_known_session_api_methods\(\)[\s\S]*?for \w+ in \[([\s\S]*?)\n {8}\]/
  )
  if (!m) throw new Error("could not locate `allows_only_known_session_api_methods` positive list")
  return new Set([...m[1].matchAll(/"([A-Za-z_][\w]*)"/g)].map((x) => x[1]))
}

/**
 * `callSessionApi`'s per-method `case` bodies as `{ method: [paramName, …] }`.
 *
 * Same idea as {@link extractControlArgs}: the `p.<name>` reads inside a case
 * ARE the positional arguments the SDK receives, so a method whose args drift
 * from the manifest is calling the SDK with the wrong shape.
 */
export function extractSessionApiArgs(source) {
  const body = source.match(/export async function callSessionApi\([\s\S]*?\n\}/)?.[0]
  if (!body) throw new Error("session-api.mjs: could not locate `callSessionApi`")
  const sw = body.match(/switch \(method\) \{([\s\S]*)/)?.[1]
  if (!sw) throw new Error("session-api.mjs: `callSessionApi` has no method switch")
  /** @type {Record<string, string[]>} */
  const out = {}
  const blocks = [...sw.matchAll(/case "([A-Za-z_]\w*)":([\s\S]*?)(?=\n {4}(?:case |default:))/g)]
  for (const [, name, block] of blocks) {
    // Only the `api.<fn>(…)` call line carries the positional arguments; the
    // surrounding comments and guards may mention `p.` too.
    const call = block.match(/return api\.\w+\(([^)]*)\)/)?.[1] ?? ""
    out[name] = [...call.matchAll(/\bp\.([A-Za-z_]\w*)/g)].map((m) => m[1])
  }
  return out
}

/** `export const MUTATING_SESSION_API_METHODS: … = [ … ]` */
export function extractMutatingSessionApiMethods(source) {
  const m = source.match(/MUTATING_SESSION_API_METHODS[^=]*=\s*\[([\s\S]*?)\n\]/)
  if (!m) throw new Error("could not locate `MUTATING_SESSION_API_METHODS`")
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]))
}

/** A `{ method: "capability" }` object literal, by declared name. */
export function extractCapabilityMap(source, name, file) {
  const body = source.match(new RegExp(`export const ${name}[^=]*= \\{([\\s\\S]*?)\\n\\}`))?.[1]
  if (!body) throw new Error(`${file}: could not locate \`${name}\``)
  return Object.fromEntries(
    [...body.matchAll(/(?:"([^"]+)"|([A-Za-z_]\w*)):\s*"([^"]+)"/g)].map((m) => [
      m[1] ?? m[2],
      m[3],
    ])
  )
}

/** `AGENT_CAPABILITY_IDS: readonly AgentCapabilityId[] = [ … ]` */
export function extractCapabilityIds(source) {
  const m = source.match(/AGENT_CAPABILITY_IDS[^=]*=\s*\[([\s\S]*?)\n\]/)
  if (!m) throw new Error("could not locate `AGENT_CAPABILITY_IDS`")
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]))
}

/**
 * `planned` and `not-exposed` are both "absent from every runtime site", and
 * they are kept apart on purpose. `planned` is a TODO. `not-exposed` is a
 * decision, and the gate demands a `reason` for it — an SDK method nobody
 * wired reads identically to one somebody deliberately declined to wire, and
 * without the distinction the next person re-litigates the decision or, worse,
 * "finishes" it.
 */
const EXPOSURES = new Set(["control", "dedicated-command", "planned", "not-exposed"])
const KINDS = new Set(["sdk", "host"])

function diff(a, b) {
  return [...a].filter((x) => !b.has(x)).sort()
}

/**
 * @param {{
 *   manifest: any,
 *   sites: Record<string, Set<string>>,
 *   sdkQueryMethods: Set<string>,
 *   capabilityIds: Set<string>,
 *   controlArgs?: Record<string, string[]>,
 *   controlCapabilities?: Record<string, string>,
 *   tsCapabilities?: Record<string, string>,
 * }} input
 * @returns {string[]}
 */
export function verify({
  manifest,
  sites,
  sdkQueryMethods,
  capabilityIds,
  controlArgs,
  controlCapabilities,
  tsCapabilities,
}) {
  const errors = []

  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.methods)) {
    return ["manifest must have schemaVersion 1 and a methods array"]
  }

  const seen = new Set()
  for (const entry of manifest.methods) {
    const label = entry?.name ?? "<unnamed>"
    if (typeof entry?.name !== "string" || !entry.name) {
      errors.push(`${label}: name must be a non-empty string`)
      continue
    }
    if (seen.has(entry.name)) errors.push(`${label}: duplicate entry`)
    seen.add(entry.name)

    if (!KINDS.has(entry.kind)) errors.push(`${label}: kind must be sdk|host`)
    if (!EXPOSURES.has(entry.exposure)) {
      errors.push(`${label}: exposure must be ${[...EXPOSURES].join("|")}`)
    }
    if (!capabilityIds.has(entry.capability)) {
      errors.push(`${label}: capability "${entry.capability}" is not a known AgentCapabilityId`)
    }
    if (entry.exposure === "not-exposed" && !entry.reason) {
      errors.push(`${label}: exposure "not-exposed" needs a \`reason\` saying why`)
    }
    // Positional arg mapping is what `controlArgs` builds from the params
    // object; without it a control frame reaches the SDK with no arguments and
    // fails somewhere far from here.
    if (entry.exposure === "control" && !Array.isArray(entry.args)) {
      errors.push(`${label}: exposure "control" needs an \`args\` array (use [] for a no-arg call)`)
    }

    // An `sdk` method must really be on the SDK; a `host` one must really not
    // be, or the "regenerate from sdk.d.ts" hazard is back.
    if (entry.kind === "sdk" && !sdkQueryMethods.has(entry.name)) {
      errors.push(`${label}: marked kind "sdk" but absent from protocol/agent-sdk-surface.json`)
    }
    if (entry.kind === "host" && sdkQueryMethods.has(entry.name)) {
      errors.push(
        `${label}: marked kind "host" but the SDK now HAS a Query method of that name — ` +
          `re-decide which one the control frame should reach`
      )
    }
  }

  const expected = new Set(
    manifest.methods.filter((m) => m.exposure === "control").map((m) => m.name)
  )
  const unreachable = new Map(
    manifest.methods
      .filter((m) => m.exposure === "planned" || m.exposure === "not-exposed")
      .map((m) => [m.name, m.exposure])
  )

  for (const [site, names] of Object.entries(sites)) {
    const missing = diff(expected, names)
    const extra = diff(names, expected)
    if (missing.length) errors.push(`${site}: missing ${missing.join(", ")}`)
    if (extra.length)
      errors.push(`${site}: has ${extra.join(", ")} which the manifest does not expose`)

    const premature = [...names].filter((n) => unreachable.has(n)).sort()
    if (premature.length) {
      errors.push(
        `${site}: allowlists ${premature.map((n) => `${n} (${unreachable.get(n)})`).join(", ")} — ` +
          `a control must not be reachable before it is wired`
      )
    }
  }

  // The positional arg mapping is a fifth declaration site, and the one whose
  // drift is silent: a method allowlisted everywhere but missing from
  // `controlArgs` reaches the SDK with zero arguments.
  if (controlArgs) {
    for (const entry of manifest.methods) {
      if (entry.exposure !== "control" || !Array.isArray(entry.args) || entry.args.length === 0) {
        continue
      }
      const mapped = controlArgs[entry.name]
      if (!mapped) {
        errors.push(
          `sidecar/dispatch/control.mjs: controlArgs has no case for \`${entry.name}\`, ` +
            `so it would be invoked with no arguments`
        )
        continue
      }
      if (mapped.join(",") !== entry.args.join(",")) {
        errors.push(
          `sidecar/dispatch/control.mjs: controlArgs(${entry.name}) passes ` +
            `[${mapped.join(", ")}] but the manifest declares [${entry.args.join(", ")}]`
        )
      }
    }
  }

  // Capability gating is what turns an unsupported control into a typed
  // `capability_error` rather than a generic `unsupported_provider`. Two
  // copies exist because the sidecar cannot import TypeScript.
  for (const [site, table] of [
    ["sidecar/dispatch/control.mjs: CONTROL_METHOD_CAPABILITIES", controlCapabilities],
    ["packages/agent-config-types/src/index.ts: SESSION_CONTROL_CAPABILITIES", tsCapabilities],
  ]) {
    if (!table) continue
    for (const entry of manifest.methods) {
      if (entry.exposure !== "control") continue
      const declared = table[entry.name]
      if (declared === undefined) {
        errors.push(`${site} is missing \`${entry.name}\``)
      } else if (declared !== entry.capability) {
        errors.push(
          `${site}.${entry.name} is "${declared}", the manifest says "${entry.capability}"`
        )
      }
    }
    for (const name of Object.keys(table)) {
      if (!expected.has(name)) {
        errors.push(`${site} has \`${name}\`, which the manifest does not expose as a control`)
      }
    }
  }

  return errors
}

/**
 * The `sessionApi` half of the manifest.
 *
 * `sdkExports` is the top-level export list rather than the Query-method list:
 * these are module-level SDK functions, and checking them against
 * `queryMethods` would pass nothing.
 *
 * @param {{
 *   sessionApi: any[],
 *   sites: Record<string, Set<string>>,
 *   sdkExports: Set<string>,
 *   capabilityIds: Set<string>,
 *   specs?: Record<string, { mutates: boolean, store: boolean }>,
 *   args?: Record<string, string[]>,
 *   capabilities?: Record<string, string>,
 *   mutating?: Set<string>,
 * }} input
 * @returns {string[]}
 */
export function verifySessionApi({
  sessionApi,
  sites,
  sdkExports,
  capabilityIds,
  specs,
  args,
  capabilities,
  mutating,
}) {
  const errors = []
  if (!Array.isArray(sessionApi)) return ["manifest must have a sessionApi array"]

  const expected = new Set()
  for (const entry of sessionApi) {
    const label = entry?.name ?? "<unnamed>"
    if (typeof entry?.name !== "string" || !entry.name) {
      errors.push(`sessionApi ${label}: name must be a non-empty string`)
      continue
    }
    if (expected.has(entry.name)) errors.push(`sessionApi ${label}: duplicate entry`)
    expected.add(entry.name)

    if (!sdkExports.has(entry.name)) {
      errors.push(`sessionApi ${label}: absent from protocol/agent-sdk-surface.json exports`)
    }
    if (!capabilityIds.has(entry.capability)) {
      errors.push(
        `sessionApi ${label}: capability "${entry.capability}" is not a known AgentCapabilityId`
      )
    }
    if (typeof entry.mutates !== "boolean") {
      errors.push(`sessionApi ${label}: \`mutates\` must be a boolean`)
    }
    if (!Array.isArray(entry.args)) {
      errors.push(`sessionApi ${label}: needs an \`args\` array (use [] for a no-arg call)`)
    }
  }

  for (const [site, names] of Object.entries(sites)) {
    const missing = diff(expected, names)
    const extra = diff(names, expected)
    if (missing.length) errors.push(`${site}: missing ${missing.join(", ")}`)
    if (extra.length) {
      errors.push(`${site}: has ${extra.join(", ")} which the manifest does not expose`)
    }
  }

  for (const entry of sessionApi) {
    if (!expected.has(entry.name)) continue

    // `mutates` is not decoration: it is what a UI reads to decide whether a
    // confirmation is owed. A read marked as a write is noise; a write marked
    // as a read deletes a transcript with no prompt.
    const spec = specs?.[entry.name]
    if (specs && !spec) {
      errors.push(`sidecar/dispatch/session-api.mjs: SESSION_API_METHODS has no \`${entry.name}\``)
    } else if (spec && spec.mutates !== entry.mutates) {
      errors.push(
        `sidecar/dispatch/session-api.mjs: SESSION_API_METHODS.${entry.name}.mutates is ` +
          `${spec.mutates}, the manifest says ${entry.mutates}`
      )
    }
    if (spec && entry.store !== undefined && spec.store !== entry.store) {
      errors.push(
        `sidecar/dispatch/session-api.mjs: SESSION_API_METHODS.${entry.name}.store is ` +
          `${spec.store}, the manifest says ${entry.store}`
      )
    }

    if (mutating && entry.mutates !== mutating.has(entry.name)) {
      errors.push(
        `packages/agent-config-types/src/index.ts: MUTATING_SESSION_API_METHODS ` +
          `${mutating.has(entry.name) ? "lists" : "omits"} \`${entry.name}\`, ` +
          `the manifest says mutates: ${entry.mutates}`
      )
    }

    if (args && Array.isArray(entry.args)) {
      const mapped = args[entry.name]
      if (!mapped) {
        errors.push(
          `sidecar/dispatch/session-api.mjs: callSessionApi has no case for \`${entry.name}\``
        )
      } else if (mapped.join(",") !== entry.args.join(",")) {
        errors.push(
          `sidecar/dispatch/session-api.mjs: callSessionApi(${entry.name}) passes ` +
            `[${mapped.join(", ")}] but the manifest declares [${entry.args.join(", ")}]`
        )
      }
    }

    if (capabilities) {
      const declared = capabilities[entry.name]
      if (declared === undefined) {
        errors.push(
          `packages/agent-config-types/src/index.ts: SESSION_API_CAPABILITIES is missing ` +
            `\`${entry.name}\``
        )
      } else if (declared !== entry.capability) {
        errors.push(
          `packages/agent-config-types/src/index.ts: SESSION_API_CAPABILITIES.${entry.name} ` +
            `is "${declared}", the manifest says "${entry.capability}"`
        )
      }
    }
  }

  for (const name of Object.keys(capabilities ?? {})) {
    if (!expected.has(name)) {
      errors.push(
        `packages/agent-config-types/src/index.ts: SESSION_API_CAPABILITIES has \`${name}\`, ` +
          `which the manifest does not expose`
      )
    }
  }

  return errors
}

export function loadAndVerify(read = (p) => readFileSync(resolve(REPO_ROOT, p), "utf8")) {
  const manifest = JSON.parse(read("protocol/agent-control-methods.json"))
  const surface = JSON.parse(read("protocol/agent-sdk-surface.json"))
  const contract = read("packages/agent-config-types/src/index.ts")
  const capabilityIds = extractCapabilityIds(
    read("packages/agent-config-types/src/agent-execution.ts")
  )

  const sites = {}
  for (const [site, extract] of Object.entries(SITES)) {
    sites[site] = extract(read(site.replace("::test", "")))
  }

  const control = read("sidecar/dispatch/control.mjs")
  const sessionApiSource = read("sidecar/dispatch/session-api.mjs")
  const rust = read("src-tauri/src/claude/commands.rs")

  return [
    ...verify({
      manifest,
      sites,
      sdkQueryMethods: new Set(Object.keys(surface.surface.queryMethods)),
      capabilityIds,
      controlArgs: extractControlArgs(control),
      controlCapabilities: extractCapabilityMap(
        control,
        "CONTROL_METHOD_CAPABILITIES",
        "sidecar/dispatch/control.mjs"
      ),
      tsCapabilities: extractCapabilityMap(
        contract,
        "SESSION_CONTROL_CAPABILITIES",
        "packages/agent-config-types/src/index.ts"
      ),
    }),
    ...verifySessionApi({
      sessionApi: manifest.sessionApi,
      sites: {
        "packages/agent-config-types/src/index.ts::SessionApiMethod":
          extractSessionApiUnion(contract),
        "sidecar/dispatch/session-api.mjs::SESSION_API_METHODS": new Set(
          Object.keys(extractSessionApiSpecs(sessionApiSource))
        ),
        "src-tauri/src/claude/commands.rs::is_allowed_session_api_method":
          extractRustSessionApiAllowlist(rust),
        "src-tauri/src/claude/commands.rs::test": extractRustSessionApiTestList(rust),
      },
      sdkExports: new Set(surface.surface.exports),
      capabilityIds,
      specs: extractSessionApiSpecs(sessionApiSource),
      args: extractSessionApiArgs(sessionApiSource),
      capabilities: extractCapabilityMap(
        contract,
        "SESSION_API_CAPABILITIES",
        "packages/agent-config-types/src/index.ts"
      ),
      mutating: extractMutatingSessionApiMethods(contract),
    }),
  ]
}

export function main() {
  const errors = loadAndVerify()
  if (errors.length) {
    console.error("[agent-control-methods] the control surface drifted:")
    for (const e of errors) console.error(`  ${e}`)
    console.error(
      "\n  protocol/agent-control-methods.json is the source. Update it first,\n" +
        "  then bring the four declaration sites into line."
    )
    return 1
  }

  const manifest = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "protocol/agent-control-methods.json"), "utf8")
  )
  const counts = manifest.methods.reduce((acc, m) => {
    acc[m.exposure] = (acc[m.exposure] ?? 0) + 1
    return acc
  }, {})
  const mutating = manifest.sessionApi.filter((m) => m.mutates).length
  console.log(
    `[agent-control-methods] OK — ${manifest.methods.length} control methods ` +
      `(${Object.entries(counts)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ")}) across ${Object.keys(SITES).length} sites, and ` +
      `${manifest.sessionApi.length} session functions (${mutating} mutating) across 4`
  )
  return 0
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-agent-control-methods.mjs")
) {
  process.exit(main())
}
