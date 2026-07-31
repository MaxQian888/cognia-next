/** @jest-environment node */
import { HOOK_EVENTS, HooksConfigSchema, hookGroupSchema, type HooksConfig } from "./types"

describe("HOOK_EVENTS", () => {
  it("includes the full round-trip set", () => {
    expect(HOOK_EVENTS).toContain("PreToolUse")
    expect(HOOK_EVENTS).toContain("PostToolUse")
    expect(HOOK_EVENTS).toContain("UserPromptSubmit")
    expect(HOOK_EVENTS).toContain("PostCompact")
    expect(HOOK_EVENTS).toContain("StopFailure")
    expect(HOOK_EVENTS).toContain("PostToolUseFailure")
    // No duplicates.
    expect(new Set(HOOK_EVENTS).size).toBe(HOOK_EVENTS.length)
  })
})

describe("HooksConfigSchema", () => {
  it("round-trips a representative settings.json hooks fragment", () => {
    const fragment = {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "echo hi", timeout: 10 }],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            { type: "command", command: "guard.sh" },
            { type: "webhook", url: "https://x.test", headers: { "X-A": "1" }, timeout: 5 },
          ],
        },
      ],
    }
    const result = HooksConfigSchema.safeParse(fragment)
    expect(result.success).toBe(true)
    const data = (result as { success: true; data: HooksConfig }).data
    expect(data.PreToolUse?.[0].matcher).toBe("Bash")
    expect(data.PreToolUse?.[0].hooks[0]).toEqual({
      type: "command",
      command: "echo hi",
      timeout: 10,
    })
    expect(data.UserPromptSubmit?.[0].hooks[1]).toMatchObject({
      type: "webhook",
      url: "https://x.test",
    })
  })

  it("preserves an unknown handler type as inert (passthrough)", () => {
    const fragment = {
      Stop: [
        {
          hooks: [{ type: "mcp_tool", server: "github", tool: "notify" }],
        },
      ],
    }
    const result = HooksConfigSchema.safeParse(fragment)
    expect(result.success).toBe(true)
    const data = (result as { success: true; data: HooksConfig }).data
    expect(data.Stop?.[0].hooks[0]).toEqual({
      type: "mcp_tool",
      server: "github",
      tool: "notify",
    })
  })

  it("tolerates unknown event keys without dropping known ones", () => {
    const fragment = {
      PreToolUse: [{ hooks: [{ type: "command", command: "x" }] }],
      SomeFutureEvent: [{ hooks: [{ type: "command", command: "y" }] }],
    }
    const result = HooksConfigSchema.safeParse(fragment)
    expect(result.success).toBe(true)
    const data = (result as { success: true; data: HooksConfig }).data
    expect(data.PreToolUse?.[0].hooks[0]).toMatchObject({ type: "command", command: "x" })
  })

  it("rejects a command handler missing its command field", () => {
    const fragment = { PreToolUse: [{ hooks: [{ type: "command" }] }] }
    // `command` is required for the command branch; with no `command` the union
    // still matches the otherHandler branch (passthrough) — so it parses as inert.
    const result = HooksConfigSchema.safeParse(fragment)
    expect(result.success).toBe(true)
  })

  it("rejects a non-array group value", () => {
    const result = HooksConfigSchema.safeParse({ PreToolUse: { hooks: [] } })
    expect(result.success).toBe(false)
  })
})

describe("hookGroupSchema", () => {
  it("accepts a group with no matcher", () => {
    const result = hookGroupSchema.safeParse({ hooks: [] })
    expect(result.success).toBe(true)
  })

  it("requires the hooks array", () => {
    const result = hookGroupSchema.safeParse({ matcher: "Bash" })
    expect(result.success).toBe(false)
  })
})
