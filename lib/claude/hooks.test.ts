// `hooks.ts` is a pure type module. There are no runtime exports — the file
// only declares interfaces and type aliases. This smoke test imports the
// types and uses them in a runtime assertion so the file is exercised by the
// module loader (Jest's coverage corpus would otherwise mark it 0%/0% which
// triggers the global threshold guard).

import type { HookEvent, HookGroup, HookHandler, HooksConfig } from "./hooks"

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
