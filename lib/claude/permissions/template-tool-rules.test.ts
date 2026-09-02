import { buildTemplateToolRuleset } from "./template-tool-rules"
import {
  TEMPLATE_READ_TOOL_NAMES,
  TEMPLATE_TOOL_NAMES,
  TEMPLATE_WRITE_TOOL_NAMES,
} from "@/lib/claude/template-builtin-tools"

describe("buildTemplateToolRuleset", () => {
  const rules = buildTemplateToolRuleset()

  it("allows the read tools", () => {
    for (const tool of TEMPLATE_READ_TOOL_NAMES) {
      expect(rules[tool]).toBe("allow")
    }
  })

  it("allows the write tools at this layer because the consent broker is their gate", () => {
    // An `ask` here would be a second confirmation on top of the consent
    // overlay, and one that cannot name the template it approves.
    for (const tool of TEMPLATE_WRITE_TOOL_NAMES) {
      expect(rules[tool]).toBe("allow")
    }
  })

  it("keys every tool twice, once per provider path", () => {
    for (const tool of TEMPLATE_TOOL_NAMES) {
      expect(rules[tool]).toBeDefined()
      expect(rules[`mcp__cognia-plugin-tools__${tool}`]).toBe(rules[tool])
    }
  })

  it("covers every shipped tool and nothing else", () => {
    const expected = [...TEMPLATE_TOOL_NAMES].flatMap((t) => [t, `mcp__cognia-plugin-tools__${t}`])
    expect(Object.keys(rules).sort()).toEqual(expected.sort())
  })
})
