/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"
import { getAdapterTransportLabelKey, getPlatformMeta } from "./platform-meta"
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
    // Planned kinds carry a label too, so the "Planned" grid card is readable.
    ["email", "email"],
    ["kook", "kook"],
    ["line", "line"],
    ["mattermost", "mattermost"],
  ])("maps %s to its label key + shared brand icon", (kind, labelKey) => {
    const meta = getPlatformMeta(kind)
    expect(meta.labelKey).toBe(labelKey)
    // Icon comes from the shared vendored brand set.
    expect(meta.Icon).toBe(getPlatformIcon(kind))
  })

  it("falls back to the 'unknown' label for non-built-in kinds", () => {
    expect(getPlatformMeta("github").labelKey).toBe("unknown")
    expect(getPlatformMeta("acme-chat").labelKey).toBe("unknown")
  })

  it("always returns a renderable icon, even for fallback kinds", () => {
    const { Icon } = getPlatformMeta("github")
    const { container } = render(<Icon className="size-4" />)
    expect(container.querySelector("svg")).not.toBeNull()
  })
})

describe("getAdapterTransportLabelKey", () => {
  it("uses the DingTalk Stream Mode label for the internal longpoll bucket", () => {
    expect(getAdapterTransportLabelKey("dingtalk", "longpoll")).toBe(
      "transportLabels.dingtalkStream"
    )
  })

  it("keeps generic longpoll adapters on the raw transport label", () => {
    expect(getAdapterTransportLabelKey("telegram", "longpoll")).toBeNull()
    expect(getAdapterTransportLabelKey("matrix", "longpoll")).toBeNull()
  })
})
