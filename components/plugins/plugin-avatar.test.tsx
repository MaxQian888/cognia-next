/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { PluginAvatar } from "./plugin-avatar"

describe("PluginAvatar", () => {
  it("renders an <img> for a data URL icon", () => {
    render(<PluginAvatar name="Alpha" icon="data:image/png;base64,abc" />)
    const img = screen.getByTestId("plugin-avatar-image") as HTMLImageElement
    expect(img.getAttribute("src")).toBe("data:image/png;base64,abc")
  })

  it("renders an <img> for an https URL icon", () => {
    render(<PluginAvatar name="Alpha" icon="https://example.com/i.png" />)
    expect(screen.getByTestId("plugin-avatar-image")).toBeInTheDocument()
  })

  it("renders a Lucide glyph for a known icon name", () => {
    render(<PluginAvatar name="Alpha" icon="Puzzle" />)
    expect(screen.getByTestId("plugin-avatar-lucide")).toBeInTheDocument()
  })

  it("falls back to an initial avatar for an unknown icon name", () => {
    render(<PluginAvatar name="Beta" icon="not-a-real-icon" />)
    const node = screen.getByTestId("plugin-avatar-initial")
    expect(node).toHaveTextContent("B")
  })

  it("falls back to an initial avatar when no icon is provided", () => {
    render(<PluginAvatar name="gamma" />)
    const node = screen.getByTestId("plugin-avatar-initial")
    // uppercased first letter
    expect(node).toHaveTextContent("G")
  })

  it("uses '?' when the name is empty", () => {
    render(<PluginAvatar name="   " />)
    expect(screen.getByTestId("plugin-avatar-initial")).toHaveTextContent("?")
  })

  it("is deterministic: the same seed yields the same colour class", () => {
    const { rerender } = render(<PluginAvatar name="X" seed="plugin_a" />)
    const first = screen.getByTestId("plugin-avatar-initial").className
    rerender(<PluginAvatar name="Y" seed="plugin_a" />)
    const second = screen.getByTestId("plugin-avatar-initial").className
    const colorClass = (cls: string) => cls.split(" ").find((c) => c.startsWith("bg-"))
    expect(colorClass(first)).toBe(colorClass(second))
  })

  it("applies the requested pixel size", () => {
    render(<PluginAvatar name="Alpha" size={32} />)
    const node = screen.getByTestId("plugin-avatar-initial")
    expect(node.style.width).toBe("32px")
    expect(node.style.height).toBe("32px")
  })
})

/**
 * The host has always resolved `manifest.icon` into a lucide / inline /
 * remote / file / public classification and stored it, and nothing read the
 * result: every surface passed the raw string, whose relative form
 * (`assets/icon.png`) fails the image test and degraded to a letter.
 */
describe("resolved icons", () => {
  it("resolves a plugin-relative asset path from the install root", () => {
    // A `file` transport needs the asset protocol, which jsdom does not have,
    // so this asserts the resolution happened by way of the honest fallback
    // rather than a broken <img>.
    render(<PluginAvatar name="Widgets" icon="assets/icon.png" pluginRoot="/plugins/widgets" />)
    expect(screen.queryByTestId("plugin-avatar-image")).toBeNull()
    expect(screen.getByTestId("plugin-avatar-initial")).toBeInTheDocument()
  })

  it("renders an inline icon supplied as a resolved value", () => {
    render(
      <PluginAvatar
        name="Widgets"
        resolvedIcon={{
          kind: "image",
          src: "data:image/png;base64,AA",
          original: "data:image/png;base64,AA",
          transport: "inline",
        }}
      />
    )
    expect(screen.getByTestId("plugin-avatar-image")).toHaveAttribute(
      "src",
      "data:image/png;base64,AA"
    )
  })

  it("renders a lucide glyph supplied as a resolved value", () => {
    render(
      <PluginAvatar
        name="Widgets"
        resolvedIcon={{ kind: "lucide", name: "Wrench", original: "Wrench" }}
      />
    )
    expect(screen.getByTestId("plugin-avatar-lucide")).toBeInTheDocument()
  })

  it("prefers an explicit resolvedIcon over the raw string", () => {
    render(
      <PluginAvatar
        name="Widgets"
        icon="https://example.test/raw.png"
        resolvedIcon={{
          kind: "image",
          src: "https://example.test/resolved.png",
          original: "x",
          transport: "remote",
        }}
      />
    )
    expect(screen.getByTestId("plugin-avatar-image")).toHaveAttribute(
      "src",
      "https://example.test/resolved.png"
    )
  })
})
