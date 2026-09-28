import type { HookEnvelope, HookInput, PluginHookFrame } from "./kernel/types.ts"
import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  HOOK_PII_BLOCK_REASON,
  SUPPORTED_EVENTS,
  buildAgentHooks,
  mergeHookMaps,
} from "./agent-hooks.ts"
import { nodeCmd } from "../../test-support/hook-command.ts"

test("model hook matchers delegate canonical target matching to the SDK", async () => {
  const seen: unknown[] = []
  const config = {
    PreModelSwitch: [
      { matcher: "claude-opus-5", hooks: [{ type: "agent", marker: "opus" }] },
      { matcher: ".*sonnet.*", hooks: [{ type: "agent", marker: "sonnet" }] },
    ],
  }
  const hooks = buildAgentHooks(config, {
    executeNativeHandler: async (handler) => {
      seen.push(handler.marker)
      return {}
    },
  })
  assert.deepEqual(
    hooks!.PreModelSwitch!.map((group) => group.matcher),
    ["claude-opus-5", ".*sonnet.*"]
  )
  // The SDK calls this callback after matching its canonicalized target name.
  await hooks!.PreModelSwitch![0]!.hooks[0]!({ to_model: "us.anthropic.claude-opus-5-v1:0[1m]" })
  assert.deepEqual(seen, ["opus"])
})

test("a PreModelSwitch hook timeout refuses the switch", async () => {
  const hooks = buildAgentHooks(
    {
      PreModelSwitch: [
        {
          hooks: [{ type: "command", command: nodeCmd("setTimeout(()=>{},1000)"), timeout: 0.01 }],
        },
      ],
    },
    {}
  )
  const result = await hooks!.PreModelSwitch![0]!.hooks[0]!({})
  assert.equal(result.hookSpecificOutput!.permissionDecision, "deny")
  assert.match(result.hookSpecificOutput!.permissionDecisionReason!, /timed out/)
})

test("PII-bearing permission and model-switch responses fail closed in the SDK contract", async () => {
  for (const event of ["PermissionRequest", "PreModelSwitch"]) {
    const hooks = buildAgentHooks(
      { [event]: [{ hooks: [{ type: "agent" }] }] },
      {
        executeNativeHandler: async () => ({
          hookSpecificOutput: {
            hookEventName: event,
            ...(event === "PermissionRequest"
              ? { decision: { behavior: "allow", updatedInput: { value: "alice@example.com" } } }
              : { permissionDecision: "allow", permissionDecisionReason: "alice@example.com" }),
          },
        }),
      }
    )
    const output = await hooks![event]![0]!.hooks[0]!({})
    assert.equal(
      event === "PermissionRequest"
        ? output.hookSpecificOutput!.decision!.behavior
        : output.hookSpecificOutput!.permissionDecision,
      "deny"
    )
    assert.equal(JSON.stringify(output).includes("alice@example.com"), false)
  }
})

test("callback logs native failures and tolerates cyclic diagnostic input", async () => {
  const config = { Stop: [{ hooks: [{ type: "agent" }] }] }
  const logs: string[][] = []
  const hooks = buildAgentHooks(config, {
    log: (...args) => logs.push(args),
    executeNativeHandler: async () => {
      throw new Error("Unavailable")
    },
  })
  const input: HookInput = { hook_origin: "hook", hook_recursion_depth: 2 }
  input.circular = input
  assert.deepEqual(await hooks!.Stop![0]!.hooks[0]!(input), {})
  assert.equal(logs.length, 1)
  config.Stop = []
  assert.deepEqual(await hooks!.Stop![0]!.hooks[0]!({}), {})
})

test("buildAgentHooks: only registers events with configured groups", () => {
  assert.equal(buildAgentHooks(undefined, {}), undefined)
  assert.equal(buildAgentHooks({}, {}), undefined)
  const map = buildAgentHooks(
    { PreToolUse: [{ hooks: [{ type: "command", command: "echo" }] }], Stop: [{ hooks: [] }] },
    { sessionId: "s", emit() {} }
  )
  assert.deepEqual(Object.keys(map!), ["PreToolUse"])
  assert.equal(typeof map!.PreToolUse![0]!.hooks[0], "function")
})

test("buildAgentHooks: callback runs handlers, emits hook_fire, returns mapped output", async () => {
  const emitted: (HookEnvelope | PluginHookFrame)[] = []
  const map = buildAgentHooks(
    {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: nodeCmd("process.stderr.write('nope');process.exit(2)"),
            },
          ],
        },
      ],
    },
    { sessionId: "sess", emit: (m) => emitted.push(m) }
  )
  const cb = map!.PreToolUse![0]!.hooks[0]
  const out = await cb!(
    { hook_event_name: "PreToolUse", session_id: "sess", tool_name: "Bash", tool_input: {} },
    "tu1",
    { signal: undefined }
  )
  assert.equal(out.hookSpecificOutput!.permissionDecision, "deny")
  assert.equal(out.hookSpecificOutput!.permissionDecisionReason, "nope")
  assert.equal(emitted.length, 1)
  assert.equal((emitted[0]! as HookEnvelope).event.subtype, "hook_fire")
  assert.equal((emitted[0]! as HookEnvelope).event.outcome, "blocked")
})

test("buildAgentHooks: refuses PII-bearing hook output before it reaches provider context", async () => {
  const map = buildAgentHooks(
    {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: nodeCmd(
                "console.log(JSON.stringify({additionalContext:'alice@example.com'}))"
              ),
            },
          ],
        },
      ],
    },
    { sessionId: "sess", emit() {} }
  )

  const out = await map!.Stop![0]!.hooks[0]!({ hook_event_name: "Stop" }, undefined, {})
  assert.deepEqual(out, { decision: "block", reason: HOOK_PII_BLOCK_REASON })
})

test("buildAgentHooks: callback no-ops (no emit) when a non-matching tool", async () => {
  const emitted: (HookEnvelope | PluginHookFrame)[] = []
  const map = buildAgentHooks(
    {
      PreToolUse: [
        { matcher: "Read", hooks: [{ type: "command", command: nodeCmd("process.exit(2)") }] },
      ],
    },
    { sessionId: "s", emit: (m) => emitted.push(m) }
  )
  const out = await map!.PreToolUse![0]!.hooks[0]!({ tool_name: "Bash" }, "t", {})
  assert.deepEqual(out, {})
  assert.equal(emitted.length, 0)
})

test("mergeHookMaps: concatenates arrays per event, skips undefined, undefined when empty", () => {
  assert.equal(mergeHookMaps(undefined, null), undefined)
  const lsp = { PostToolUse: [{ hooks: [async () => ({})] }] }
  const agent = {
    PostToolUse: [{ hooks: [async () => ({})] }],
    PreToolUse: [{ hooks: [async () => ({})] }],
  }
  const merged = mergeHookMaps(lsp, agent)
  assert.equal(merged!.PostToolUse!.length, 2)
  assert.equal(merged!.PreToolUse!.length, 1)
})

test("buildAgentHooks emits a structured audit for each matched handler", async () => {
  const audits: HookEnvelope[] = []
  const map = buildAgentHooks(
    { Stop: [{ hooks: [{ type: "prompt", prompt: "review", policyClass: "managed" }] }] },
    {
      sessionId: "sess",
      emit() {},
      emitAudit: (event) => audits.push(event),
      executeNativeHandler: async () => ({ output: "{}" }),
    }
  )
  await map!.Stop![0]!.hooks[0]!({ hook_event_name: "Stop" }, undefined, {})
  assert.equal(audits.length, 1)
  assert.equal(audits[0]!.event.subtype, "hook_audit")
  assert.equal(audits[0]!.event.handlerType, "prompt")
  assert.equal(audits[0]!.event.policyClass, "managed")
  assert.equal(audits[0]!.event.outcome, "allowed")
})

test("every SDK lifecycle event can be configured, not just the three tool ones", async () => {
  // Before this, `SUPPORTED_EVENTS` was a hand-written list of three. The other
  // 28 could be written into settings.json and would never run — no error, no
  // log, just a hook that silently did nothing.
  assert.equal(SUPPORTED_EVENTS.length, 33)

  const config = Object.fromEntries(
    SUPPORTED_EVENTS.map((e) => [e, [{ hooks: [{ type: "command", command: "true" }] }]])
  )
  const map = buildAgentHooks(config, { sessionId: "s", emit() {} })
  assert.deepEqual(Object.keys(map!).sort(), [...SUPPORTED_EVENTS].sort())
})

test("a configured-but-empty group registers nothing", () => {
  const map = buildAgentHooks({ Stop: [{ hooks: [] }] }, { sessionId: "s", emit() {} })
  assert.equal(map, undefined)
})

test("buildAgentHooks: the identity reaches the hook script as real stdin fields", async () => {
  // End-to-end through the SDK callback: a command hook that reads stdin and
  // blocks only when it sees the injected identity. Proves the merge happens
  // before serialization, not just that resolveAgentIdentity computes it.
  const script = join(tmpdir(), `cognia-hook-identity-${process.pid}.mjs`)
  writeFileSync(
    script,
    [
      'import { readFileSync } from "node:fs"',
      'const p = JSON.parse(readFileSync(0, "utf8"))',
      'if (p.agent_kind === "teammate" && p.agent_ref === "reviewer") {',
      '  process.stderr.write("saw identity")',
      "  process.exit(2)",
      "}",
      "process.exit(0)",
    ].join("\n")
  )

  const map = buildAgentHooks(
    {
      PostToolUse: [
        { hooks: [{ type: "command", command: `${process.execPath} ${JSON.stringify(script)}` }] },
      ],
    },
    { emit: () => {}, sessionId: "s1", agentKind: "teammate", agentRef: "reviewer" }
  )
  const callback = map!.PostToolUse![0]!.hooks[0]
  const out = await callback!({ tool_name: "Bash" }, undefined, {})
  assert.match(JSON.stringify(out), /saw identity/)

  // Same hook, no host identity → the script sees no agent_kind and allows.
  const anon = buildAgentHooks(
    {
      PostToolUse: [
        { hooks: [{ type: "command", command: `${process.execPath} ${JSON.stringify(script)}` }] },
      ],
    },
    { emit: () => {}, sessionId: "s1" }
  )
  const anonOut = await anon!.PostToolUse![0]!.hooks[0]!({ tool_name: "Bash" }, undefined, {})
  assert.doesNotMatch(JSON.stringify(anonOut), /saw identity/)
})

test("buildAgentHooks: tool_provenance reaches the hook script as a real stdin field", async () => {
  // End-to-end through the SDK callback: a command hook that reads stdin and
  // blocks only when the resolved provenance names the right plugin. Proves
  // the manifest-driven resolution happens before payload serialization.
  const script = join(tmpdir(), `cognia-hook-provenance-${process.pid}.mjs`)
  writeFileSync(
    script,
    [
      'import { readFileSync } from "node:fs"',
      'const p = JSON.parse(readFileSync(0, "utf8"))',
      'if (p.tool_provenance?.kind === "plugin" && p.tool_provenance?.source === "ripgrep-tools") {',
      '  process.stderr.write("saw plugin provenance")',
      "  process.exit(2)",
      "}",
      'if (p.tool_provenance?.kind === "builtin" && p.tool_provenance?.declared_by === "builtin-tools-data.json") {',
      '  process.stderr.write("saw builtin provenance")',
      "  process.exit(2)",
      "}",
      "process.exit(0)",
    ].join("\n")
  )
  const groups = {
    PreToolUse: [
      { hooks: [{ type: "command", command: `${process.execPath} ${JSON.stringify(script)}` }] },
    ],
  }
  const pluginTools = [{ name: "ripgrep-tools:ripgrep_search", pluginId: "ripgrep-tools" }]
  const map = buildAgentHooks(groups, { emit: () => {}, sessionId: "s1", pluginTools })
  const cb = map!.PreToolUse![0]!.hooks[0]

  const pluginOut = await cb!(
    { tool_name: "mcp__cognia-plugin-tools__ripgrep-tools:ripgrep_search", tool_input: {} },
    undefined,
    {}
  )
  assert.match(JSON.stringify(pluginOut), /saw plugin provenance/)

  const builtinOut = await cb!({ tool_name: "Bash", tool_input: {} }, undefined, {})
  assert.match(JSON.stringify(builtinOut), /saw builtin provenance/)

  // A session-scoped event carries no tool name → no provenance field at all.
  const noToolScript = join(tmpdir(), `cognia-hook-no-prov-${process.pid}.mjs`)
  writeFileSync(
    noToolScript,
    [
      'import { readFileSync } from "node:fs"',
      'const p = JSON.parse(readFileSync(0, "utf8"))',
      'if (!("tool_provenance" in p)) {',
      '  process.stderr.write("absent")',
      "  process.exit(2)",
      "}",
      "process.exit(0)",
    ].join("\n")
  )
  const stopMap = buildAgentHooks(
    {
      Stop: [
        {
          hooks: [
            { type: "command", command: `${process.execPath} ${JSON.stringify(noToolScript)}` },
          ],
        },
      ],
    },
    { emit: () => {}, sessionId: "s1", pluginTools }
  )
  const stopOut = await stopMap!.Stop![0]!.hooks[0]!({ hook_event_name: "Stop" }, undefined, {})
  assert.match(JSON.stringify(stopOut), /absent/)
})
