/**
 * Tests for lib/connectors/platform-capabilities.ts.
 */

import { getPlatformCapabilities } from "./platform-capabilities"
import { LARK_CAPS } from "./adapters/lark/capability"
import { SLACK_CAPS } from "./adapters/slack/capability"

describe("getPlatformCapabilities", () => {
  it("returns the adapter's declared caps for a known platform", () => {
    expect(getPlatformCapabilities("lark")).toBe(LARK_CAPS)
    expect(getPlatformCapabilities("lark")).toContain("rich-card.lark")
  })

  it("resolves each capability-bearing platform to a non-empty list", () => {
    expect(getPlatformCapabilities("slack")).toBe(SLACK_CAPS)
    for (const p of [
      "telegram",
      "discord",
      "slack",
      "lark",
      "onebot",
      "dingtalk",
      "wecom",
      "wechat-oa",
      "wechat-personal",
      "qq-official",
      "matrix",
    ] as const) {
      expect(getPlatformCapabilities(p).length).toBeGreaterThan(0)
    }
  })

  it("returns [] for platforms without a dedicated capability const", () => {
    for (const p of ["email", "kook", "line", "mattermost", "github"] as const) {
      expect(getPlatformCapabilities(p)).toEqual([])
    }
  })
})
