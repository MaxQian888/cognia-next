/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"
import { getPlatformMeta } from "./platform-meta"
import { getPlatformIcon } from "@/components/connectors/platform-icons"
import type { PlatformKind } from "@/types/connectors/platform-kind"

describe("getPlatformMeta", () => {
  it.each<[PlatformKind, string]>([
    ["telegram", "telegram"],
    ["discord", "discord"],
    ["slack", "slack"],
    ["lark", "lark"],
    ["onebot", "onebot"],
    ["wecom", "wecom"],
    ["wechat-personal", "wechat-personal"],
    ["wechat-oa", "wechat-oa"],
    ["qq-official", "qq-official"],
    ["matrix", "matrix"],
    ["dingtalk", "dingtalk"],
  ])("maps %s to its label key + shared brand icon", (kind, labelKey) => {
    const meta = getPlatformMeta(kind)
    expect(meta.labelKey).toBe(labelKey)
    // Icon comes from the shared vendored brand set.
    expect(meta.Icon).toBe(getPlatformIcon(kind))
  })

  it("falls back to the 'unknown' label for kinds without a dialog", () => {
    expect(getPlatformMeta("github").labelKey).toBe("unknown")
    expect(getPlatformMeta("kook").labelKey).toBe("unknown")
  })

  it("always returns a renderable icon, even for fallback kinds", () => {
    const { Icon } = getPlatformMeta("github")
    const { container } = render(<Icon className="size-4" />)
    expect(container.querySelector("svg")).not.toBeNull()
  })
})
