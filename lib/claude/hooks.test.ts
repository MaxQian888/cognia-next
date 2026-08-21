// `hooks.ts` is a pure type module. There are no runtime exports — the file
// only declares interfaces and type aliases. This smoke test imports the
// types and uses them in a runtime assertion so the file is exercised by the
// module loader (Jest's coverage corpus would otherwise mark it 0%/0% which
// triggers the global threshold guard).

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { DORMANT_HOOK_HANDLER_FIELDS, HOOK_AGENT_KINDS, isHookAgentKind } from "./hooks"
import type { HookAgentKind, HookEvent, HookGroup, HookHandler, HooksConfig } from "./hooks"

describe("hooks types module", () => {
  it("HookHandler accepts a command shape", () => {
    const cmd: HookHandler = { type: "command", command: "echo hi", timeout: 5 }
    expect(cmd.type).toBe("command")
  })

  it("HookHandler accepts a webhook shape", () => {
    const webhook: HookHandler = {
      type: "webhook",
      url: "https://example.com/hook",
      headers: { "X-Token": "abc" },
      timeout: 10,
    }
    expect(webhook.type).toBe("webhook")
  })

  it("HookHandler accepts every Claude native handler shape and the legacy webhook alias", () => {
    const handlers: HookHandler[] = [
      { type: "command", command: "node", args: ["guard.mjs"], async: true },
      {
        type: "http",
        url: "https://example.test/hook",
        headers: { Authorization: "Bearer $TOKEN" },
        allowedEnvVars: ["TOKEN"],
      },
      { type: "mcp_tool", server: "policy", tool: "check", input: { path: "${tool_input.path}" } },
      { type: "prompt", prompt: "Approve this input: $ARGUMENTS", model: "haiku" },
      { type: "agent", prompt: "Inspect this input: $ARGUMENTS", model: "sonnet" },
      { type: "webhook", url: "https://legacy.example.test/hook" },
    ]

    expect(handlers.map((handler) => handler.type)).toEqual([
      "command",
      "http",
      "mcp_tool",
      "prompt",
      "agent",
      "webhook",
    ])
  })

  it("HookGroup carries a matcher and handlers", () => {
    const group: HookGroup = {
      matcher: "*",
      hooks: [{ type: "command", command: "ls" }],
    }
    expect(group.hooks).toHaveLength(1)
  })

  it("HooksConfig keys come from the HookEvent union", () => {
    const events: HookEvent[] = [
      "PreToolUse",
      "PostToolUse",
      "UserPromptSubmit",
      "Stop",
      "SessionStart",
    ]
    const config: HooksConfig = {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo" }] }],
    }
    expect(events.length).toBeGreaterThan(0)
    expect(config.PreToolUse?.[0].matcher).toBe("Bash")
  })
})

describe("HookAgentKind", () => {
  it("recognises every declared kind and rejects anything else", () => {
    for (const kind of HOOK_AGENT_KINDS) expect(isHookAgentKind(kind)).toBe(true)
    expect(isHookAgentKind("teammates")).toBe(false)
    expect(isHookAgentKind("")).toBe(false)
    // Guards against the enum being narrowed by accident: the `agents`
    // selector's UI enumerates this list, so a silently-dropped member would
    // make an existing user config unmatched.
    expect([...HOOK_AGENT_KINDS].sort()).toEqual([
      "chat",
      "connector",
      "external",
      "goal-judge",
      "plan-step",
      "scheduler",
      "subagent",
      "system",
      "teammate",
    ])
  })

  it("HookGroup carries an `agents` selector alongside `matcher`", () => {
    const kind: HookAgentKind = "teammate"
    const group: HookGroup = {
      matcher: "Bash",
      agents: kind,
      hooks: [{ type: "command", command: "guard.mjs" }],
    }
    // Both selectors are independent and optional.
    const toolOnly: HookGroup = { matcher: "Bash", hooks: [] }
    const agentOnly: HookGroup = { agents: "chat", hooks: [] }
    expect(group.agents).toBe("teammate")
    expect(toolOnly.agents).toBeUndefined()
    expect(agentOnly.matcher).toBeUndefined()
  })
})

describe("dormant handler fields", () => {
  const ROOT = join(__dirname, "../..")
  const RUNNERS = [
    "sidecar/dispatch/agent-hooks.mjs",
    "src-tauri/src/hooks/command.rs",
    "src-tauri/src/hooks/webhook.rs",
    "src-tauri/src/hooks/types.rs",
    "cli/src/hooks/run-hooks.ts",
  ]

  it("names exactly the fields the type declares but no runner reads", () => {
    // The third axis of the dormancy rule: documented at the type, labelled in
    // the settings UI, and pinned here. If a runner starts honouring one of
    // these, this test fails and forces the list (and the UI notice) to follow.
    const sources = RUNNERS.map((rel) => readFileSync(join(ROOT, rel), "utf8"))
    for (const field of DORMANT_HOOK_HANDLER_FIELDS) {
      for (const [i, src] of sources.entries()) {
        // `timeout` and `policyClass` are deliberately NOT in the list — they
        // ARE honoured — so any hit here is a real contradiction.
        expect({ field, runner: RUNNERS[i], read: src.includes(`"${field}"`) }).toEqual({
          field,
          runner: RUNNERS[i],
          read: false,
        })
      }
    }
  })

  it("does not list the fields that are actually honoured", () => {
    expect(DORMANT_HOOK_HANDLER_FIELDS).not.toContain("timeout")
    expect(DORMANT_HOOK_HANDLER_FIELDS).not.toContain("policyClass")
    expect(DORMANT_HOOK_HANDLER_FIELDS).not.toContain("command")
    expect(DORMANT_HOOK_HANDLER_FIELDS).not.toContain("url")
  })
})
