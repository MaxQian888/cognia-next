import test from "node:test"
import assert from "node:assert/strict"

import {
  verify,
  verifySessionApi,
  loadAndVerify,
  extractControlArgs,
  extractCapabilityMap,
  extractTsUnion,
  extractSidecarSet,
  extractRustAllowlist,
  extractRustTestList,
  extractCapabilityIds,
  extractMutatingSessionApiMethods,
  extractRustSessionApiAllowlist,
  extractRustSessionApiTestList,
  extractSessionApiArgs,
  extractSessionApiSpecs,
  extractSessionApiUnion,
} from "./check-agent-control-methods.mjs"

const CAPS = new Set(["mcp", "steer", "set-model", "checkpoint", "context-management"])
const SDK_METHODS = new Set(["getContextUsage", "setModel", "rewindFiles"])

const MANIFEST = {
  schemaVersion: 1,
  methods: [
    {
      name: "getContextUsage",
      kind: "sdk",
      exposure: "control",
      capability: "context-management",
      args: [],
    },
    {
      name: "setModel",
      kind: "sdk",
      exposure: "control",
      capability: "set-model",
      args: ["model"],
    },
    {
      name: "steer",
      kind: "host",
      exposure: "control",
      capability: "steer",
      args: ["prompt", "priority"],
    },
    { name: "rewindFiles", kind: "sdk", exposure: "planned", capability: "checkpoint" },
  ],
}

const EXPOSED = ["getContextUsage", "setModel", "steer"]

function sites(overrides = {}) {
  const base = {
    ts: new Set(EXPOSED),
    sidecar: new Set(EXPOSED),
    rust: new Set(EXPOSED),
    rustTest: new Set(EXPOSED),
  }
  return { ...base, ...overrides }
}

function run(manifest = MANIFEST, siteOverrides = {}) {
  return verify({
    manifest,
    sites: sites(siteOverrides),
    sdkQueryMethods: SDK_METHODS,
    capabilityIds: CAPS,
  })
}

test("passes when every site agrees with the manifest", () => {
  assert.deepEqual(run(), [])
})

test("catches a site missing an exposed method", () => {
  const errors = run(MANIFEST, { sidecar: new Set(["getContextUsage", "steer"]) })
  assert.match(errors.join("\n"), /sidecar: missing setModel/)
})

test("catches a site allowlisting something the manifest does not expose", () => {
  const errors = run(MANIFEST, { rust: new Set([...EXPOSED, "evalSync"]) })
  assert.match(errors.join("\n"), /rust: has evalSync which the manifest does not expose/)
})

test("catches a still-planned method that leaked into a runtime allowlist", () => {
  // The dangerous form of "built but dormant": the call reaches a live Query.
  const errors = run(MANIFEST, { ts: new Set([...EXPOSED, "rewindFiles"]) })
  assert.match(errors.join("\n"), /allowlists rewindFiles \(planned\)/)
})

test("catches an sdk-kind method that is not on the SDK", () => {
  const manifest = {
    ...MANIFEST,
    methods: [
      ...MANIFEST.methods,
      { name: "teleport", kind: "sdk", exposure: "planned", capability: "mcp" },
    ],
  }
  const errors = verify({
    manifest,
    sites: sites(),
    sdkQueryMethods: SDK_METHODS,
    capabilityIds: CAPS,
  })
  assert.match(errors.join("\n"), /teleport: marked kind "sdk" but absent from/)
})

test("catches the steer trap — a host method the SDK later grows", () => {
  // If the SDK ever ships a real `steer`, silently keeping the host intercept
  // would route the control frame to the wrong implementation.
  const errors = verify({
    manifest: MANIFEST,
    sites: sites(),
    sdkQueryMethods: new Set([...SDK_METHODS, "steer"]),
    capabilityIds: CAPS,
  })
  assert.match(errors.join("\n"), /steer: marked kind "host" but the SDK now HAS a Query method/)
})

test("rejects an unknown capability id", () => {
  const manifest = {
    ...MANIFEST,
    methods: [
      ...MANIFEST.methods,
      { name: "rewindFiles", kind: "sdk", exposure: "planned", capability: "time-travel" },
    ],
  }
  const errors = verify({
    manifest,
    sites: sites(),
    sdkQueryMethods: SDK_METHODS,
    capabilityIds: CAPS,
  })
  assert.match(errors.join("\n"), /is not a known AgentCapabilityId/)
})

test("rejects duplicates and bad enums", () => {
  const errors = verify({
    manifest: {
      schemaVersion: 1,
      methods: [
        { name: "setModel", kind: "sdk", exposure: "control", capability: "set-model" },
        { name: "setModel", kind: "wat", exposure: "someday", capability: "set-model" },
      ],
    },
    sites: sites({
      ts: new Set(["setModel"]),
      sidecar: new Set(["setModel"]),
      rust: new Set(["setModel"]),
      rustTest: new Set(["setModel"]),
    }),
    sdkQueryMethods: SDK_METHODS,
    capabilityIds: CAPS,
  })
  const joined = errors.join("\n")
  assert.match(joined, /duplicate entry/)
  assert.match(joined, /kind must be sdk\|host/)
  assert.match(joined, /exposure must be/)
})

test("rejects a malformed manifest outright", () => {
  assert.deepEqual(run({ schemaVersion: 2, methods: [] }), [
    "manifest must have schemaVersion 1 and a methods array",
  ])
})

// ---- extractors, against realistic source shapes ----------------------------

test("extractTsUnion reads the union members", () => {
  const src = `
/** Allowlisted SDK \`Query\` control methods reachable via \`sessionControl\`. */
export type SessionControlMethod =
  | "getContextUsage"
  | "setModel"
  | "steer"

/**
 * Sidecar -> renderer reply.
 */
`
  assert.deepEqual([...extractTsUnion(src)], ["getContextUsage", "setModel", "steer"])
})

test("extractSidecarSet reads the Set literal", () => {
  const src = `export const CONTROL_METHODS = new Set([\n  "getContextUsage",\n  "steer",\n])\n`
  assert.deepEqual([...extractSidecarSet(src)], ["getContextUsage", "steer"])
})

test("extractRustAllowlist reads the matches! arm", () => {
  const src = `pub fn is_allowed_control_method(method: &str) -> bool {
    matches!(
        method,
        "getContextUsage"
            | "steer"
    )
}
`
  assert.deepEqual([...extractRustAllowlist(src)], ["getContextUsage", "steer"])
})

test("extractRustTestList reads only the positive list, not the negative one", () => {
  const src = `    fn allows_only_known_control_methods() {
        for m in [
            "getContextUsage",
            "steer",
        ] {
            assert!(is_allowed_control_method(m));
        }
        for m in [
            "close",
            "__proto__",
        ] {
            assert!(!is_allowed_control_method(m));
        }
    }
`
  const names = extractRustTestList(src)
  assert.deepEqual([...names], ["getContextUsage", "steer"])
  assert.ok(!names.has("__proto__"), "the negative list must not be read as allowed")
})

test("extractCapabilityIds reads the runtime array", () => {
  const src = `export const AGENT_CAPABILITY_IDS: readonly AgentCapabilityId[] = [\n  "streaming",\n  "mcp",\n]\n`
  assert.deepEqual([...extractCapabilityIds(src)], ["streaming", "mcp"])
})

// ---- the real repo ----------------------------------------------------------

test("live: the committed manifest matches all four real declaration sites", () => {
  assert.deepEqual(loadAndVerify(), [])
})

// ---- the two extra declaration sites -------------------------------------------

const ARGS = { setModel: ["model"], steer: ["prompt", "priority"] }
const CAP_MAP = {
  getContextUsage: "context-management",
  setModel: "set-model",
  steer: "steer",
}

const runFull = (overrides = {}) =>
  verify({
    manifest: MANIFEST,
    sites: sites(),
    sdkQueryMethods: SDK_METHODS,
    capabilityIds: CAPS,
    controlArgs: ARGS,
    controlCapabilities: CAP_MAP,
    tsCapabilities: CAP_MAP,
    ...overrides,
  })

test("passes when the arg mapping and both capability maps agree", () => {
  assert.deepEqual(runFull(), [])
})

test("catches a control that would be invoked with no arguments", () => {
  // The silent one: allowlisted everywhere, but `controlArgs` has no case, so
  // the SDK is called with zero args and does something harmless-looking.
  const errors = runFull({ controlArgs: { steer: ["prompt", "priority"] } })
  assert.match(errors.join("\n"), /controlArgs has no case for `setModel`/)
})

test("catches an arg mapping that forwards the wrong params, or the wrong order", () => {
  assert.match(
    runFull({ controlArgs: { ...ARGS, setModel: ["modelId"] } }).join("\n"),
    /controlArgs\(setModel\) passes \[modelId\] but the manifest declares \[model\]/
  )
  assert.match(
    runFull({ controlArgs: { ...ARGS, steer: ["priority", "prompt"] } }).join("\n"),
    /controlArgs\(steer\)/
  )
})

test("catches a capability map that disagrees with the manifest, on either side", () => {
  for (const key of ["controlCapabilities", "tsCapabilities"]) {
    const errors = runFull({ [key]: { ...CAP_MAP, setModel: "mcp" } })
    assert.match(errors.join("\n"), /setModel is "mcp", the manifest says "set-model"/)

    const missing = { ...CAP_MAP }
    delete missing.steer
    assert.match(runFull({ [key]: missing }).join("\n"), /is missing `steer`/)

    assert.match(
      runFull({ [key]: { ...CAP_MAP, rewindFiles: "checkpoint" } }).join("\n"),
      /has `rewindFiles`, which the manifest does not expose as a control/
    )
  }
})

test("a not-exposed method must say why, and must stay out of every site", () => {
  const manifest = {
    schemaVersion: 1,
    methods: [
      ...MANIFEST.methods,
      { name: "streamInput", kind: "sdk", exposure: "not-exposed", capability: "mcp" },
    ],
  }
  const sdkQueryMethods = new Set([...SDK_METHODS, "streamInput"])
  const bare = verify({ manifest, sites: sites(), sdkQueryMethods, capabilityIds: CAPS })
  assert.match(bare.join("\n"), /exposure "not-exposed" needs a `reason` saying why/)

  manifest.methods.at(-1).reason = "takes an AsyncIterable a JSON frame cannot carry"
  assert.deepEqual(verify({ manifest, sites: sites(), sdkQueryMethods, capabilityIds: CAPS }), [])

  // Same treatment as `planned`: a decision not to wire it is still a decision
  // that it must not be reachable.
  const leaked = verify({
    manifest,
    sites: sites({ rust: new Set([...EXPOSED, "streamInput"]) }),
    sdkQueryMethods,
    capabilityIds: CAPS,
  })
  assert.match(leaked.join("\n"), /allowlists streamInput \(not-exposed\)/)
})

test("extractControlArgs reads the case bodies in positional order", () => {
  const source = `
export function controlArgs(method, params) {
  const p = params ?? {}
  switch (method) {
    case "toggleMcpServer":
      return [p.serverName, p.enabled]
    case "seedReadState":
      return [p.path, p.mtime]
    default:
      return []
  }
}
`
  assert.deepEqual(extractControlArgs(source), {
    toggleMcpServer: ["serverName", "enabled"],
    seedReadState: ["path", "mtime"],
  })
})

// ---- the session_api half ------------------------------------------------------

const SESSION_API = [
  { name: "listSessions", capability: "session.manage", mutates: false, args: [], store: true },
  {
    name: "deleteSession",
    capability: "session.manage",
    mutates: true,
    args: ["sessionId"],
    store: true,
  },
  {
    name: "resolveSettings",
    capability: "session.manage",
    mutates: false,
    args: [],
    store: false,
  },
]
const SESSION_NAMES = SESSION_API.map((m) => m.name)
const SESSION_EXPORTS = new Set([...SESSION_NAMES, "query", "startup"])
const SESSION_CAPS = new Set(["session.manage", "session.store", "subagents.manage"])
const SESSION_SPECS = {
  listSessions: { mutates: false, store: true },
  deleteSession: { mutates: true, store: true },
  resolveSettings: { mutates: false, store: false },
}
const SESSION_ARGS = { listSessions: [], deleteSession: ["sessionId"], resolveSettings: [] }
const SESSION_CAP_MAP = {
  listSessions: "session.manage",
  deleteSession: "session.manage",
  resolveSettings: "session.manage",
}

const runSessionApi = (overrides = {}) =>
  verifySessionApi({
    sessionApi: SESSION_API,
    sites: {
      ts: new Set(SESSION_NAMES),
      sidecar: new Set(SESSION_NAMES),
      rust: new Set(SESSION_NAMES),
      rustTest: new Set(SESSION_NAMES),
    },
    sdkExports: SESSION_EXPORTS,
    capabilityIds: SESSION_CAPS,
    specs: SESSION_SPECS,
    args: SESSION_ARGS,
    capabilities: SESSION_CAP_MAP,
    mutating: new Set(["deleteSession"]),
    ...overrides,
  })

test("sessionApi: passes when every site agrees", () => {
  assert.deepEqual(runSessionApi(), [])
})

test("sessionApi: catches a site that drifted in either direction", () => {
  assert.match(
    runSessionApi({
      sites: {
        ts: new Set(SESSION_NAMES),
        sidecar: new Set(["listSessions"]),
        rust: new Set(SESSION_NAMES),
        rustTest: new Set(SESSION_NAMES),
      },
    }).join("\n"),
    /sidecar: missing deleteSession, resolveSettings/
  )
  assert.match(
    runSessionApi({
      sites: {
        ts: new Set(SESSION_NAMES),
        sidecar: new Set(SESSION_NAMES),
        rust: new Set([...SESSION_NAMES, "deleteEverything"]),
        rustTest: new Set(SESSION_NAMES),
      },
    }).join("\n"),
    /rust: has deleteEverything which the manifest does not expose/
  )
})

test("sessionApi: a method the SDK does not export is rejected", () => {
  // These are module-level exports, so the check runs against the export list
  // rather than the Query-method list — checking the latter would pass nothing.
  assert.match(
    runSessionApi({
      sessionApi: [
        ...SESSION_API,
        { name: "purgeAll", capability: "session.manage", mutates: true, args: [] },
      ],
      sites: {
        ts: new Set([...SESSION_NAMES, "purgeAll"]),
        sidecar: new Set([...SESSION_NAMES, "purgeAll"]),
        rust: new Set([...SESSION_NAMES, "purgeAll"]),
        rustTest: new Set([...SESSION_NAMES, "purgeAll"]),
      },
    }).join("\n"),
    /purgeAll: absent from protocol\/agent-sdk-surface\.json exports/
  )
})

test("sessionApi: a write mislabelled as a read is caught on both sides", () => {
  // This is the one that costs a user data: a UI reads `mutates` to decide
  // whether a confirmation is owed, so a write marked as a read deletes a
  // transcript with no prompt.
  assert.match(
    runSessionApi({
      specs: { ...SESSION_SPECS, deleteSession: { mutates: false, store: true } },
    }).join("\n"),
    /SESSION_API_METHODS\.deleteSession\.mutates is false, the manifest says true/
  )
  assert.match(
    runSessionApi({ mutating: new Set() }).join("\n"),
    /MUTATING_SESSION_API_METHODS omits `deleteSession`, the manifest says mutates: true/
  )
  assert.match(
    runSessionApi({ mutating: new Set(["deleteSession", "listSessions"]) }).join("\n"),
    /MUTATING_SESSION_API_METHODS lists `listSessions`, the manifest says mutates: false/
  )
})

test("sessionApi: a store flag that disagrees is caught", () => {
  assert.match(
    runSessionApi({
      specs: { ...SESSION_SPECS, resolveSettings: { mutates: false, store: true } },
    }).join("\n"),
    /SESSION_API_METHODS\.resolveSettings\.store is true, the manifest says false/
  )
})

test("sessionApi: a wrong or missing positional arg mapping is caught", () => {
  assert.match(
    runSessionApi({ args: { listSessions: [], resolveSettings: [] } }).join("\n"),
    /callSessionApi has no case for `deleteSession`/
  )
  assert.match(
    runSessionApi({ args: { ...SESSION_ARGS, deleteSession: ["id"] } }).join("\n"),
    /callSessionApi\(deleteSession\) passes \[id\] but the manifest declares \[sessionId\]/
  )
})

test("sessionApi: the capability map is checked in both directions", () => {
  assert.match(
    runSessionApi({
      capabilities: { ...SESSION_CAP_MAP, deleteSession: "session.store" },
    }).join("\n"),
    /SESSION_API_CAPABILITIES\.deleteSession is "session\.store", the manifest says "session\.manage"/
  )
  const missing = { ...SESSION_CAP_MAP }
  delete missing.listSessions
  assert.match(
    runSessionApi({ capabilities: missing }).join("\n"),
    /SESSION_API_CAPABILITIES is missing `listSessions`/
  )
  assert.match(
    runSessionApi({ capabilities: { ...SESSION_CAP_MAP, forkSession: "session.manage" } }).join(
      "\n"
    ),
    /SESSION_API_CAPABILITIES has `forkSession`, which the manifest does not expose/
  )
})

test("sessionApi: an unknown capability id and a missing args array are rejected", () => {
  assert.match(
    runSessionApi({
      sessionApi: [{ name: "listSessions", capability: "time-travel", mutates: false }],
      sites: { ts: new Set(["listSessions"]) },
      specs: undefined,
      args: undefined,
      capabilities: undefined,
      mutating: undefined,
    }).join("\n"),
    /is not a known AgentCapabilityId[\s\S]*needs an `args` array/
  )
})

test("sessionApi: a missing sessionApi array fails outright", () => {
  assert.deepEqual(runSessionApi({ sessionApi: undefined }), [
    "manifest must have a sessionApi array",
  ])
})

test("extractSessionApiUnion / extractSessionApiSpecs read their real shapes", () => {
  assert.deepEqual(
    [
      ...extractSessionApiUnion(`
export type SessionApiMethod =
  | "deleteSession"
  | "listSessions"

/** next thing */
`),
    ],
    ["deleteSession", "listSessions"]
  )

  assert.deepEqual(
    extractSessionApiSpecs(`export const SESSION_API_METHODS = {
  listSessions: { mutates: false, store: true },
  deleteSession: { mutates: true, store: true },
  // Reads the settings layers only.
  resolveSettings: { mutates: false, store: false },
}
`),
    SESSION_SPECS
  )
})

test("extractSessionApiArgs reads only the api.* call, not the comments around it", () => {
  const source = `
export async function callSessionApi({ method, params, store, api = X }) {
  const p = params ?? {}
  switch (method) {
    case "listSessions":
      return api.listSessions(options)
    case "getSubagentMessages":
      // p.agentId is documented as required; p.dir is not consulted here.
      return api.getSubagentMessages(p.sessionId, p.agentId, options)
    case "importSessionToStore": {
      if (!store) throw new Error("no_session_store")
      return api.importSessionToStore(p.sessionId, store, options)
    }
    default:
      throw new Error("unknown_method")
  }
}
`
  assert.deepEqual(extractSessionApiArgs(source), {
    listSessions: [],
    getSubagentMessages: ["sessionId", "agentId"],
    importSessionToStore: ["sessionId"],
  })
})

test("extractRustSessionApiAllowlist / TestList read their own halves", () => {
  const src = `pub fn is_allowed_session_api_method(method: &str) -> bool {
    matches!(
        method,
        "deleteSession"
            | "listSessions"
    )
}

    fn allows_only_known_session_api_methods() {
        for m in [
            "deleteSession",
            "listSessions",
        ] {
            assert!(is_allowed_session_api_method(m));
        }
        for m in [
            "setModel",
            "__proto__",
        ] {
            assert!(!is_allowed_session_api_method(m));
        }
    }
`
  assert.deepEqual([...extractRustSessionApiAllowlist(src)], ["deleteSession", "listSessions"])
  const names = extractRustSessionApiTestList(src)
  assert.deepEqual([...names], ["deleteSession", "listSessions"])
  assert.ok(!names.has("setModel"), "the negative list must not be read as allowed")
})

test("extractMutatingSessionApiMethods reads the exported array", () => {
  assert.deepEqual(
    [
      ...extractMutatingSessionApiMethods(`
export const MUTATING_SESSION_API_METHODS: readonly SessionApiMethod[] = [
  "deleteSession",
  "renameSession",
]
`),
    ],
    ["deleteSession", "renameSession"]
  )
})

test("extractCapabilityMap reads a { method: capability } literal", () => {
  const source = `
export const CONTROL_METHOD_CAPABILITIES = {
  setModel: "set-model",
  "weird-name": "mcp",
}
`
  assert.deepEqual(extractCapabilityMap(source, "CONTROL_METHOD_CAPABILITIES", "f.mjs"), {
    setModel: "set-model",
    "weird-name": "mcp",
  })
  assert.throws(() => extractCapabilityMap(source, "NOPE", "f.mjs"), /f\.mjs: could not locate/)
})
