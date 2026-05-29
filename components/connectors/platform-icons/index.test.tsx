/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"
import { getPlatformIcon } from "./index"
import { ALL_PLATFORM_KINDS, type PlatformKind } from "@/types/connectors/platform-kind"

describe("getPlatformIcon", () => {
  it("returns a renderable component for every platform kind", () => {
    for (const kind of ALL_PLATFORM_KINDS) {
      const Icon = getPlatformIcon(kind)
      expect(Icon).toBeTruthy()
      const { container, unmount } = render(<Icon className="size-4" />)
      expect(container.querySelector("svg")).not.toBeNull()
      unmount()
    }
  })

  it("renders the brand mark with currentColor + the supplied class", () => {
    const Icon = getPlatformIcon("telegram")
    const { container } = render(<Icon className="text-sky-500" />)
    const svg = container.querySelector("svg")
    expect(svg).toHaveClass("text-sky-500")
    expect(svg).toHaveAttribute("fill", "currentColor")
    expect(svg?.querySelector("path")).not.toBeNull()
  })

  it("shares one mark across the WeChat family and the QQ family", () => {
    expect(getPlatformIcon("wechat-personal")).toBe(getPlatformIcon("wechat-oa"))
    expect(getPlatformIcon("wechat-personal")).toBe(getPlatformIcon("wecom"))
    expect(getPlatformIcon("qq-official")).toBe(getPlatformIcon("onebot"))
  })

  it("falls back to a generic glyph for an unknown kind", () => {
    const Icon = getPlatformIcon("totally-unknown" as PlatformKind)
    const { container } = render(<Icon className="size-4" />)
    expect(container.querySelector("svg")).not.toBeNull()
  })
})
