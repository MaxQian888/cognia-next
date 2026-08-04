import test from "node:test"
import assert from "node:assert/strict"

import {
  verify,
  loadAndVerify,
  extractRuntimeCapabilities,
  extractAdapterCapabilities,
  extractCommandCapabilities,
  extractCapabilityIds,
} from "./check-adapter-capability-parity.mjs"

const IDS = new Set([
  "steer",
  "compaction",
  "permissions.set-mode",
  "set-model",
  "session.resume",
  "checkpoint",
  "plugins.native",
])

const base = () => ({
  runtime: {
    "claude-agent-sdk": new Set(["steer", "compaction", "permissions.set-mode", "session.resume"]),
    "ai-sdk": new Set(["compaction", "permissions.set-mode"]),
    external: new Set(["steer"]),
  },
  adapter: {
    "claude-agent-sdk": new Set(["steer", "compaction", "permissions.set-mode", "session.resume"]),
    "ai-sdk": new Set(["compaction", "permissions.set-mode"]),
  },
  commands: { compact: "compaction", set_mode: "permissions.set-mode", steer: "steer" },
  capabilityIds: IDS,
})

test("passes when both tables agree on every gated capability", () => {
  assert.deepEqual(verify(base()), [])
})

test("catches the steer bug: a gated capability no dispatchable adapter declares", () => {
  // The real defect. Both tables "agreed" — by both omitting `steer` — so a
  // pairwise-equality check saw nothing, while every steer command on a
  // frozen spec returned capability_error even though `routeSteer()` works.
  const input = base()
  input.runtime["claude-agent-sdk"].delete("steer")
  input.adapter["claude-agent-sdk"].delete("steer")

  const errors = verify(input)
  assert.match(errors.join("\n"), /gates on "steer", which no dispatchable adapter declares/)
})

test("catches a capability the resolver has and the sidecar table forgot", () => {
  const input = base()
  input.adapter["claude-agent-sdk"].delete("compaction")
  assert.match(
    verify(input).join("\n"),
    /the sidecar table omits it, so `compact` is rejected on a runtime that supports it/
  )
})

test("catches a capability the sidecar serves and the resolver never freezes", () => {
  const input = base()
  input.runtime["ai-sdk"].delete("compaction")
  assert.match(verify(input).join("\n"), /the spec under-reports what the session can do/)
})

test("catches a sidecar-only capability that no spec can ever carry", () => {
  const input = base()
  input.adapter["ai-sdk"].add("session.resume")
  assert.match(
    verify(input).join("\n"),
    /ai-sdk: ADAPTER_CAPABILITIES has "session\.resume", absent from RUNTIME_CAPABILITIES/
  )
})

test("catches a misspelled capability id in any of the three tables", () => {
  const runtimeTypo = base()
  runtimeTypo.runtime["ai-sdk"].add("compactionn")
  assert.match(verify(runtimeTypo).join("\n"), /RUNTIME_CAPABILITIES\.ai-sdk: "compactionn"/)

  const commandTypo = base()
  commandTypo.commands.restore = "compation"
  assert.match(verify(commandTypo).join("\n"), /COMMAND_CAPABILITIES\.restore: "compation"/)
})

test("ignores `external`, which has no sidecar dispatcher to disagree with", () => {
  const input = base()
  input.runtime.external.add("compaction")
  assert.deepEqual(verify(input), [])
})

// ---- extractors, against realistic source shapes ----------------------------

test("extractRuntimeCapabilities reads the quoted and bare adapter keys", () => {
  const src = `export const RUNTIME_CAPABILITIES: Record<AgentRuntimeAdapterId, readonly AgentCapabilityId[]> = {
  "claude-agent-sdk": [
    "streaming",
    // a comment, and a capability below it
    "steer",
  ],
  external: [
    "streaming",
  ],
}
`
  const out = extractRuntimeCapabilities(src)
  assert.deepEqual([...out["claude-agent-sdk"]], ["streaming", "steer"])
  assert.deepEqual([...out.external], ["streaming"])
})

test("extractAdapterCapabilities reads the Set literals", () => {
  const src = `export const ADAPTER_CAPABILITIES = {
  "claude-agent-sdk": new Set([
    "compaction",
    "steer",
  ]),
  "ai-sdk": new Set([
    "compaction",
  ]),
}
`
  const out = extractAdapterCapabilities(src)
  assert.deepEqual([...out["claude-agent-sdk"]], ["compaction", "steer"])
})

test("extractCommandCapabilities reads the command map", () => {
  const src = `export const COMMAND_CAPABILITIES = {
  compact: "compaction",
  steer: "steer",
}
`
  assert.deepEqual(extractCommandCapabilities(src), { compact: "compaction", steer: "steer" })
})

test("extractCapabilityIds reads the contract array", () => {
  const src = `export const AGENT_CAPABILITY_IDS: readonly AgentCapabilityId[] = [\n  "steer",\n  "mcp",\n]\n`
  assert.deepEqual([...extractCapabilityIds(src)], ["steer", "mcp"])
})

test("each extractor names the declaration it could not find", () => {
  assert.throws(() => extractRuntimeCapabilities(""), /RUNTIME_CAPABILITIES/)
  assert.throws(() => extractAdapterCapabilities(""), /ADAPTER_CAPABILITIES/)
  assert.throws(() => extractCommandCapabilities(""), /COMMAND_CAPABILITIES/)
  assert.throws(() => extractCapabilityIds(""), /AGENT_CAPABILITY_IDS/)
})

// ---- the real repo ----------------------------------------------------------

test("live: the two committed capability tables agree", () => {
  assert.deepEqual(loadAndVerify(), [])
})

// ---- control-method capabilities ---------------------------------------------

test("catches a control gated on a capability no adapter declares", () => {
  // Same failure as the steer bug, one surface over: the control frame would
  // always come back as `capability_error`.
  const errors = verify({
    ...base(),
    controlCapabilities: { reloadPlugins: "plugins.native" },
  })
  assert.match(
    errors.join("\n"),
    /CONTROL_METHOD_CAPABILITIES.reloadPlugins gates on "plugins.native", which no adapter declares/
  )
})

test("a control is satisfied by ANY adapter, not by both", () => {
  // Deliberately weaker than the host-command check: a capability id can mean
  // different things per rail (`mcp` = has MCP tools on ai-sdk, = can
  // introspect MCP servers on claude), so demanding both agree flags a real
  // difference as drift.
  assert.deepEqual(
    verify({
      ...base(),
      adapter: { ...base().adapter, "claude-agent-sdk": new Set(["steer", "checkpoint"]) },
      runtime: { ...base().runtime, "claude-agent-sdk": new Set(["steer", "checkpoint"]) },
      controlCapabilities: { rewindFiles: "checkpoint" },
    }),
    []
  )
})

test("catches a misspelled capability in the control map", () => {
  assert.match(
    verify({ ...base(), controlCapabilities: { rewindFiles: "chekpoint" } }).join("\n"),
    /CONTROL_METHOD_CAPABILITIES.rewindFiles: "chekpoint" is not a known AgentCapabilityId/
  )
})

test("comments that quote a capability id are not read as table entries", () => {
  // Both tables are heavily commented, and a quoted word in a comment used to
  // register as an entry — which is how a perfectly correct table failed.
  const source = `
export const ADAPTER_CAPABILITIES = {
  "claude-agent-sdk": new Set([
    // reachable as a live "control" method
    "steer",
  ]),
}
`
  assert.deepEqual(extractAdapterCapabilities(source), {
    "claude-agent-sdk": new Set(["steer"]),
  })
})
