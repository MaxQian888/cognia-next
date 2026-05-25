import { getPlatformMeta } from "./platform-meta"
import {
  BirdIcon,
  BotIcon,
  HashIcon,
  MessageCircleIcon,
  MessagesSquareIcon,
  SendIcon,
} from "lucide-react"
import type { PlatformKind } from "@/types/connectors/platform-kind"

describe("getPlatformMeta", () => {
  it.each<[PlatformKind, string, unknown]>([
    ["telegram", "telegram", SendIcon],
    ["discord", "discord", MessagesSquareIcon],
    ["slack", "slack", HashIcon],
    ["lark", "lark", BirdIcon],
    ["onebot", "onebot", BotIcon],
  ])("maps %s to its label key + icon", (kind, labelKey, Icon) => {
    const meta = getPlatformMeta(kind)
    expect(meta.labelKey).toBe(labelKey)
    expect(meta.Icon).toBe(Icon)
  })

  it("falls back to a generic glyph for kinds without a dialog", () => {
    const meta = getPlatformMeta("matrix")
    expect(meta.labelKey).toBe("unknown")
    expect(meta.Icon).toBe(MessageCircleIcon)
  })

  it("falls back for an unknown plugin-contributed kind", () => {
    const meta = getPlatformMeta("github")
    expect(meta.labelKey).toBe("unknown")
    expect(meta.Icon).toBe(MessageCircleIcon)
  })
})
