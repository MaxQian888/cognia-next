import { MEDIA_TOOL_NAMES, VIDEO_GENERATE_TOOL_NAME } from "@/lib/claude/media-builtin-tools"
import { buildMediaToolRuleset } from "./media-tool-rules"

const NS = "mcp__cognia-plugin-tools__"

describe("buildMediaToolRuleset", () => {
  const rules = buildMediaToolRuleset()

  it("asks before starting a paid generation and allows the status read", () => {
    expect(rules[VIDEO_GENERATE_TOOL_NAME]).toBe("ask")
    expect(rules.video_status).toBe("allow")
  })

  it("keys every tool twice, because the two provider paths see different names", () => {
    for (const tool of MEDIA_TOOL_NAMES) {
      expect(rules[tool]).toBeDefined()
      expect(rules[`${NS}${tool}`]).toBe(rules[tool])
    }
  })

  it("covers every shipped media tool and nothing else", () => {
    const expected = new Set<string>()
    for (const tool of MEDIA_TOOL_NAMES) {
      expected.add(tool)
      expected.add(`${NS}${tool}`)
    }
    expect(new Set(Object.keys(rules))).toEqual(expected)
  })
})
