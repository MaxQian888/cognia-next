/** @jest-environment jsdom */
import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("@/lib/tauri/opener", () => ({
  openExternal: jest.fn(async () => undefined),
}))
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => false),
}))
jest.mock("@/lib/platform/detect", () => ({
  isCapacitor: jest.fn(() => false),
}))
jest.mock("@/lib/browser/open-url-request", () => ({
  requestBrowserUrl: jest.fn(() => false),
}))

import { ExternalLink } from "./external-link"
import { openExternal } from "@/lib/tauri/opener"
import { isTauri } from "@/lib/tauri"
import { isCapacitor } from "@/lib/platform/detect"
import { requestBrowserUrl } from "@/lib/browser/open-url-request"

const mockOpen = openExternal as jest.Mock
const mockIsTauri = isTauri as jest.Mock
const mockIsCapacitor = isCapacitor as jest.Mock
const mockRequestBrowserUrl = requestBrowserUrl as jest.Mock

beforeEach(() => {
  mockOpen.mockClear()
  mockIsTauri.mockReturnValue(false)
  mockIsCapacitor.mockReturnValue(false)
  mockRequestBrowserUrl.mockReset()
  mockRequestBrowserUrl.mockReturnValue(false)
})

describe("ExternalLink", () => {
  it("renders an anchor with sane defaults", () => {
    render(
      <ExternalLink href="https://example.com" data-testid="lnk">
        site
      </ExternalLink>
    )
    const a = screen.getByTestId("lnk")
    expect(a).toHaveAttribute("href", "https://example.com")
    expect(a).toHaveAttribute("target", "_blank")
    expect(a).toHaveAttribute("rel", "noopener noreferrer")
  })

  it("does NOT intercept on plain web (lets target=_blank do its job)", () => {
    render(
      <ExternalLink href="https://example.com" data-testid="lnk">
        site
      </ExternalLink>
    )
    const clicked = fireEvent.click(screen.getByTestId("lnk"))
    // event not prevented → the browser handles the navigation
    expect(clicked).toBe(true)
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it("routes http(s) clicks through openExternal on Capacitor", () => {
    mockIsCapacitor.mockReturnValue(true)
    render(
      <ExternalLink href="https://example.com/x" data-testid="lnk">
        site
      </ExternalLink>
    )
    const notPrevented = fireEvent.click(screen.getByTestId("lnk"))
    expect(notPrevented).toBe(false) // preventDefault called
    expect(mockOpen).toHaveBeenCalledWith("https://example.com/x")
  })

  it("routes http(s) clicks through openExternal on Tauri", () => {
    mockIsTauri.mockReturnValue(true)
    render(
      <ExternalLink href="http://foo.test" data-testid="lnk">
        site
      </ExternalLink>
    )
    fireEvent.click(screen.getByTestId("lnk"))
    expect(mockOpen).toHaveBeenCalledWith("http://foo.test")
  })

  it("leaves non-http hrefs (mailto/tel/anchor) untouched even on native", () => {
    mockIsCapacitor.mockReturnValue(true)
    render(
      <ExternalLink href="mailto:a@b.com" data-testid="lnk">
        mail
      </ExternalLink>
    )
    fireEvent.click(screen.getByTestId("lnk"))
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it("keeps document fragments in the current browsing context", () => {
    render(
      <ExternalLink href="#details" data-testid="lnk">
        details
      </ExternalLink>
    )
    const link = screen.getByTestId("lnk")
    expect(link).not.toHaveAttribute("target")
    expect(link).not.toHaveAttribute("rel")
  })

  it("preserves explicit target and rel values for non-http links", () => {
    render(
      <ExternalLink href="#details" target="_self" rel="bookmark" data-testid="lnk">
        details
      </ExternalLink>
    )
    const link = screen.getByTestId("lnk")
    expect(link).toHaveAttribute("target", "_self")
    expect(link).toHaveAttribute("rel", "bookmark")
  })

  it("never offers a link to a pane unless the surface opted in", () => {
    mockRequestBrowserUrl.mockReturnValue(true)
    render(
      <ExternalLink href="https://example.com" data-testid="lnk">
        site
      </ExternalLink>
    )
    fireEvent.click(screen.getByTestId("lnk"))
    expect(mockRequestBrowserUrl).not.toHaveBeenCalled()
  })

  it("lets a visible pane claim an opted-in link instead of the OS browser", () => {
    mockIsTauri.mockReturnValue(true)
    mockRequestBrowserUrl.mockReturnValue(true)
    render(
      <ExternalLink href="https://example.com/doc" preferEmbedded data-testid="lnk">
        site
      </ExternalLink>
    )
    const notPrevented = fireEvent.click(screen.getByTestId("lnk"))
    expect(notPrevented).toBe(false) // preventDefault called
    expect(mockRequestBrowserUrl).toHaveBeenCalledWith("https://example.com/doc")
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it("falls back to the OS browser when no pane claims the link", () => {
    mockIsTauri.mockReturnValue(true)
    mockRequestBrowserUrl.mockReturnValue(false)
    render(
      <ExternalLink href="https://example.com/doc" preferEmbedded data-testid="lnk">
        site
      </ExternalLink>
    )
    fireEvent.click(screen.getByTestId("lnk"))
    expect(mockOpen).toHaveBeenCalledWith("https://example.com/doc")
  })

  it("falls back to the native target=_blank on plain web when unclaimed", () => {
    mockRequestBrowserUrl.mockReturnValue(false)
    render(
      <ExternalLink href="https://example.com" preferEmbedded data-testid="lnk">
        site
      </ExternalLink>
    )
    const notPrevented = fireEvent.click(screen.getByTestId("lnk"))
    expect(notPrevented).toBe(true)
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it("leaves a modified click entirely to the browser on plain web", () => {
    mockRequestBrowserUrl.mockReturnValue(true)
    render(
      <ExternalLink href="https://example.com" preferEmbedded data-testid="lnk">
        site
      </ExternalLink>
    )
    const notPrevented = fireEvent.click(screen.getByTestId("lnk"), { metaKey: true })
    expect(notPrevented).toBe(true)
    expect(mockRequestBrowserUrl).not.toHaveBeenCalled()
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it("keeps a modified click OUT of the pane but still off to the OS browser", () => {
    // The modifier's meaning is "not here" — it is not permission to fall back
    // to `target="_blank"`, which is the route this component exists because
    // Tauri and the Capacitor WebView do not honour. Skipping the native
    // handoff too left a ⌘-click doing nothing at all on those shells.
    mockIsTauri.mockReturnValue(true)
    mockRequestBrowserUrl.mockReturnValue(true)
    render(
      <ExternalLink href="https://example.com" preferEmbedded data-testid="lnk">
        site
      </ExternalLink>
    )
    const notPrevented = fireEvent.click(screen.getByTestId("lnk"), { metaKey: true })
    expect(notPrevented).toBe(false) // preventDefault called
    expect(mockRequestBrowserUrl).not.toHaveBeenCalled()
    expect(mockOpen).toHaveBeenCalledWith("https://example.com")
  })

  it("does the same on Capacitor, where a new tab does not exist either", () => {
    mockIsCapacitor.mockReturnValue(true)
    render(
      <ExternalLink href="https://example.com" data-testid="lnk">
        site
      </ExternalLink>
    )
    fireEvent.click(screen.getByTestId("lnk"), { ctrlKey: true })
    expect(mockOpen).toHaveBeenCalledWith("https://example.com")
  })

  it("still fires the caller's onClick and respects preventDefault", () => {
    mockIsCapacitor.mockReturnValue(true)
    const onClick = jest.fn((e: React.MouseEvent) => e.preventDefault())
    render(
      <ExternalLink href="https://example.com" onClick={onClick} data-testid="lnk">
        site
      </ExternalLink>
    )
    fireEvent.click(screen.getByTestId("lnk"))
    expect(onClick).toHaveBeenCalled()
    // caller prevented default → we must NOT also route through openExternal
    expect(mockOpen).not.toHaveBeenCalled()
  })
})
