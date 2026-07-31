import { fireEvent, render, screen } from "@testing-library/react"

import { BrowserWebFallback } from "./browser-web-fallback"

const openExternal = jest.fn().mockResolvedValue(undefined)
let mockFrameViewportWidth = 1280

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))

jest.mock("@/lib/tauri/opener", () => ({
  openExternal: (...args: unknown[]) => openExternal(...args),
}))

jest.mock("@/hooks/use-element-width", () => ({
  useElementWidth: () => mockFrameViewportWidth,
}))

describe("BrowserWebFallback", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrameViewportWidth = 1280
  })

  it("navigates submitted URLs and keeps browser history controls usable", () => {
    render(<BrowserWebFallback initialUrl="https://example.com/one" />)

    const address = screen.getByRole("textbox", { name: "browser.url.placeholder" })
    expect(address).toHaveValue("https://example.com/one")
    expect(screen.getByTitle("browser.webFallback.frameTitle")).toHaveAttribute(
      "src",
      "https://example.com/one"
    )

    fireEvent.change(address, { target: { value: "example.com/two" } })
    fireEvent.submit(address.closest("form")!)
    expect(screen.getByTitle("browser.webFallback.frameTitle")).toHaveAttribute(
      "src",
      "https://example.com/two"
    )

    fireEvent.click(screen.getByRole("button", { name: "browser.actions.back" }))
    expect(address).toHaveValue("https://example.com/one")

    fireEvent.click(screen.getByRole("button", { name: "browser.actions.forward" }))
    expect(address).toHaveValue("https://example.com/two")

    const frameBeforeReload = screen.getByTitle("browser.webFallback.frameTitle")
    fireEvent.click(screen.getByRole("button", { name: "browser.actions.reload" }))
    expect(screen.getByTitle("browser.webFallback.frameTitle")).not.toBe(frameBeforeReload)
  })

  it("starts empty and ignores blank address submissions", () => {
    render(<BrowserWebFallback />)

    const address = screen.getByRole("textbox", { name: "browser.url.placeholder" })
    const frame = screen.getByTitle("browser.webFallback.frameTitle")
    expect(frame).not.toHaveAttribute("src")
    expect(screen.getByRole("button", { name: "browser.actions.back" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "browser.actions.forward" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "browser.actions.reload" })).toBeDisabled()

    fireEvent.change(address, { target: { value: "   " } })
    fireEvent.keyDown(address, { key: "Enter" })
    fireEvent.submit(address.closest("form")!)

    expect(frame).not.toHaveAttribute("src")
  })

  it("opens the current URL externally and links to the existing companion setting", () => {
    render(<BrowserWebFallback initialUrl="https://example.com/current" />)

    fireEvent.click(screen.getByRole("button", { name: "browser.actions.openExternal" }))
    expect(openExternal).toHaveBeenCalledWith("https://example.com/current")
    expect(screen.getByRole("link", { name: "browser.webFallback.enableRemote" })).toHaveAttribute(
      "href",
      "/settings?section=companion"
    )
  })

  it("lets the fallback notice shrink within the workbench", () => {
    render(<BrowserWebFallback initialUrl="https://example.com/current" />)

    const notice = screen.getByText("browser.webFallback.notice")

    expect(notice.parentElement).toHaveClass("min-w-0")
    expect(notice).toHaveClass("min-w-0", "flex-1")
  })

  it("fits a desktop page to the current pane and restores its natural size when widened", () => {
    mockFrameViewportWidth = 640
    const { rerender } = render(<BrowserWebFallback initialUrl="https://example.com/current" />)

    const frame = screen.getByTitle("browser.webFallback.frameTitle")
    expect(frame).toHaveStyle({
      width: "160%",
      height: "160%",
      transform: "scale(0.625)",
      transformOrigin: "top left",
    })

    mockFrameViewportWidth = 1280
    rerender(<BrowserWebFallback initialUrl="https://example.com/current" />)

    expect(frame).toHaveStyle({
      width: "100%",
      height: "100%",
      transform: "scale(1)",
    })
  })

  it("keeps the page at natural size until the pane has been measured", () => {
    mockFrameViewportWidth = 0
    render(<BrowserWebFallback initialUrl="https://example.com/current" />)

    expect(screen.getByTitle("browser.webFallback.frameTitle")).toHaveStyle({
      width: "100%",
      height: "100%",
      transform: "scale(1)",
    })
  })
})
