import {
  EDITOR_WRITE_TOOL_NAMES,
  SAVE_EDITOR_BUFFERS_TOOL_NAME,
} from "@/lib/claude/editor-builtin-tools"
import { buildEditorToolRuleset } from "./editor-tool-rules"
import { mergeRulesets, resolvePermission, resolvePermissionDetailed } from "./ruleset"

const rules = buildEditorToolRuleset()
const resolve = (tool: string, extra: Parameters<typeof mergeRulesets>[0][] = []) =>
  resolvePermission(tool, undefined, [rules, ...(extra as never[])])

describe("the tier", () => {
  it("asks only for the tool that writes the user's own unsaved edits", () => {
    const asking = EDITOR_WRITE_TOOL_NAMES.filter((t) => resolve(t) === "ask")
    expect(asking).toEqual([SAVE_EDITOR_BUFFERS_TOOL_NAME])
  })

  it("allows the four that only move the viewport or reflect an existing write", () => {
    for (const tool of EDITOR_WRITE_TOOL_NAMES) {
      if (tool === SAVE_EDITOR_BUFFERS_TOOL_NAME) continue
      expect(resolve(tool)).toBe("allow")
    }
  })

  it("does not gate show_editor_diff — it IS the review affordance", () => {
    // A confirmation in front of "let me show you this for confirmation" is a
    // loop, not a safeguard.
    expect(resolve("show_editor_diff")).toBe("allow")
  })

  it("says nothing about the engine-agnostic read tool", () => {
    // `read_active_editor` works wherever any editor is mounted and has its own
    // PII gate; it must not inherit the Pro-IDE write tier.
    expect(rules).not.toHaveProperty("read_active_editor")
  })
})

describe("provider naming", () => {
  it("covers both the bare and the mcp-namespaced form of every tool", () => {
    // The Anthropic path sees the bare name, the AI-SDK path the namespaced
    // one, and the resolver matches tool keys exactly. Keying one form would
    // apply the tier on one provider only.
    for (const tool of EDITOR_WRITE_TOOL_NAMES) {
      expect(rules).toHaveProperty(tool)
      expect(rules).toHaveProperty(`mcp__cognia-plugin-tools__${tool}`)
    }
  })

  it("gives both forms the same verdict", () => {
    for (const tool of EDITOR_WRITE_TOOL_NAMES) {
      expect(resolve(`mcp__cognia-plugin-tools__${tool}`)).toBe(resolve(tool))
    }
  })

  it("adds no other keys", () => {
    expect(Object.keys(rules)).toHaveLength(EDITOR_WRITE_TOOL_NAMES.length * 2)
  })
})

describe("precedence", () => {
  it("is the lowest layer, so an explicit user rule overrides the ask", () => {
    const verdict = resolvePermission(SAVE_EDITOR_BUFFERS_TOOL_NAME, undefined, [
      rules,
      { [SAVE_EDITOR_BUFFERS_TOOL_NAME]: "allow" },
    ])
    expect(verdict).toBe("allow")
  })

  it("lets a user tighten an allowed tool too", () => {
    const verdict = resolvePermission("open_in_editor", undefined, [
      rules,
      { open_in_editor: "deny" },
    ])
    expect(verdict).toBe("deny")
  })

  it("reports as an explicit layer, not the permissive baked-in default", () => {
    // Layer > 0 is what stops the Auto-mode orchestrator treating the verdict as
    // "nothing was configured, run the classifier".
    const resolved = resolvePermissionDetailed("open_in_editor", undefined, [rules])
    expect(resolved.layer).toBeGreaterThan(0)
  })

  it("survives merging with the user's own tool rules", () => {
    const merged = mergeRulesets(rules, { Bash: { "rm *": "deny" } })
    expect(resolvePermission(SAVE_EDITOR_BUFFERS_TOOL_NAME, undefined, [merged])).toBe("ask")
    expect(resolvePermission("open_in_editor", undefined, [merged])).toBe("allow")
  })
})
