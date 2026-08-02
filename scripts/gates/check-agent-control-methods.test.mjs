import test from "node:test"
import assert from "node:assert/strict"

import {
  verify,
  loadAndVerify,
  extractTsUnion,
  extractSidecarSet,
  extractRustAllowlist,
  extractRustTestList,
  extractCapabilityIds,
} from "./check-agent-control-methods.mjs"

const CAPS = new Set(["mcp", "steer", "set-model", "checkpoint", "context-management"])
const SDK_METHODS = new Set(["getContextUsage", "setModel", "rewindFiles"])

const MANIFEST = {
  schemaVersion: 1,
  methods: [
    { name: "getContextUsage", kind: "sdk", exposure: "control", capability: "context-management" },
    { name: "setModel", kind: "sdk", exposure: "control", capability: "set-model" },
    { name: "steer", kind: "host", exposure: "control", capability: "steer" },
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
  assert.match(errors.join("\n"), /allowlists rewindFiles, still marked "planned"/)
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
