/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { render, screen } from "@testing-library/react"

import { PluginScreenshotGallery } from "./plugin-screenshot-gallery"

describe("PluginScreenshotGallery", () => {
  it("renders nothing without screenshots", () => {
    const { container } = render(<PluginScreenshotGallery screenshots={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders remote and inline previews directly", () => {
    render(
      <PluginScreenshotGallery
        screenshots={["https://example.test/a.png", "data:image/png;base64,AA"]}
      />
    )
    expect(screen.getAllByTestId("plugin-screenshot")).toHaveLength(2)
  })

  // Same guard the icon resolver applies: an entry that climbs out of the
  // install root is refused, not rendered.
  it("drops an entry that escapes the install root", () => {
    render(
      <PluginScreenshotGallery
        screenshots={["../../etc/passwd.png"]}
        pluginRoot="/plugins/widgets"
        convertFileSrc={(p) => `asset://${p}`}
      />
    )
    expect(screen.queryByTestId("plugin-screenshot-gallery")).toBeNull()
  })

  it("resolves a plugin-relative path through the asset protocol", () => {
    render(
      <PluginScreenshotGallery
        screenshots={["shots/one.png"]}
        pluginRoot="/plugins/widgets"
        convertFileSrc={(p) => `asset://localhost/${p}`}
      />
    )
    expect(screen.getByTestId("plugin-screenshot")).toHaveAttribute(
      "src",
      "asset://localhost//plugins/widgets/shots/one.png"
    )
  })

  // An empty frame with a heading would claim the plugin ships previews when
  // this host cannot load any of them.
  it("renders nothing when no entry is loadable here", () => {
    const { container } = render(
      <PluginScreenshotGallery screenshots={["shots/one.png"]} pluginRoot="/plugins/widgets" />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
