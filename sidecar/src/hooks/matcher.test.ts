import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { matcherMatches, agentsMatch, resolveAgentIdentity } from "./agent-hooks.ts"

test("matcherMatches: omitted / empty / star match all", () => {
  assert.equal(matcherMatches(undefined, "Bash"), true)
  assert.equal(matcherMatches(null, "Bash"), true)
  assert.equal(matcherMatches("", "Bash"), true)
  assert.equal(matcherMatches("   ", "Bash"), true)
  assert.equal(matcherMatches("*", "Bash"), true)
})

test("matcherMatches: pipe-set is exact match", () => {
  assert.equal(matcherMatches("Bash|Edit", "Bash"), true)
  assert.equal(matcherMatches("Bash|Edit", "Edit"), true)
  assert.equal(matcherMatches("Bash|Edit", "Read"), false)
})

test("matcherMatches: non-literal is regex, invalid regex is false", () => {
  assert.equal(matcherMatches("^Notebook", "NotebookEdit"), true)
  assert.equal(matcherMatches("^Notebook", "Read"), false)
  assert.equal(matcherMatches("mcp__.*__write.*", "mcp__github__write_file"), true)
  assert.equal(matcherMatches("(", "anything"), false)
})

test("matcher conformance: this rail defines the canonical rule", () => {
  // The sidecar is canonical, so this asserts the TABLE still describes what
  // this implementation does. If someone changes the rule here deliberately,
  // this test fails first and the table (and the two ports) must follow.
  const table = JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../hooks/matcher-conformance.json"), "utf8")
  )
  assert.ok(table.cases.length > 0)
  assert.ok(table.narrowCases.length > 0)
  for (const [key, narrow] of [
    ["cases", false],
    ["narrowCases", true],
  ] as const) {
    for (const c of table[key]) {
      assert.equal(
        matcherMatches(c.matcher, c.target, narrow),
        c.expected,
        `${key}: matcher=${JSON.stringify(c.matcher)} target=${JSON.stringify(c.target)} — ${c.why}`
      )
    }
  }
})

test("resolveAgentIdentity: host identity names the turn the SDK cannot", () => {
  // cognia never launches with `--agent`, so a teammate turn reaches the SDK
  // with no agent_id/agent_type at all — the host has to name it.
  assert.deepEqual(
    resolveAgentIdentity({ tool_name: "Bash" }, { agentKind: "teammate", agentRef: "reviewer" }),
    { agent_kind: "teammate", agent_ref: "reviewer" }
  )
  // No host identity and no SDK identity → no fields at all, so a narrowed
  // hook cannot match an unidentified turn.
  assert.deepEqual(resolveAgentIdentity({ tool_name: "Bash" }, {}), {})
})

test("resolveAgentIdentity: an SDK Task subagent wins over the host identity", () => {
  // A Task subagent spawned inside a teammate turn is a subagent, not a
  // teammate — otherwise `agents: "teammate"` would leak into its tool calls.
  assert.deepEqual(
    resolveAgentIdentity(
      { agent_id: "ag_1", agent_type: "explore" },
      { agentKind: "teammate", agentRef: "reviewer" }
    ),
    { agent_kind: "subagent", agent_ref: "explore" }
  )
})

test("agentsMatch: absent/star selector matches everything", () => {
  const id = { agent_kind: "teammate", agent_ref: "reviewer" }
  assert.equal(agentsMatch(undefined, id), true)
  assert.equal(agentsMatch(null, id), true)
  assert.equal(agentsMatch("", id), true)
  assert.equal(agentsMatch("*", id), true)
  // Absent selector still matches when there is no identity at all — every
  // pre-existing config keeps its behaviour.
  assert.equal(agentsMatch(undefined, {}), true)
})

test("agentsMatch: matches either the kind or the ref, with matcher syntax", () => {
  const id = { agent_kind: "teammate", agent_ref: "reviewer" }
  assert.equal(agentsMatch("teammate", id), true)
  assert.equal(agentsMatch("reviewer", id), true)
  assert.equal(agentsMatch("chat|teammate", id), true)
  assert.equal(agentsMatch("^review", id), true)
  assert.equal(agentsMatch("chat", id), false)
  assert.equal(agentsMatch("planner", id), false)
})

test("agentsMatch: a present selector never matches an unidentified event", () => {
  // A hook that asked to be narrowed must not fire on a turn we cannot name.
  assert.equal(agentsMatch("teammate", {}), false)
  assert.equal(agentsMatch("teammate", { agent_kind: "" }), false)
  assert.equal(agentsMatch("teammate", undefined), false)
})
