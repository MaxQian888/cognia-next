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

import { ExternalLink } from "./external-link"
import { openExternal } from "@/lib/tauri/opener"
import { isTauri } from "@/lib/tauri"
import { isCapacitor } from "@/lib/platform/detect"

const mockOpen = openExternal as jest.Mock
const mockIsTauri = isTauri as jest.Mock
const mockIsCapacitor = isCapacitor as jest.Mock

beforeEach(() => {
  mockOpen.mockClear()
  mockIsTauri.mockReturnValue(false)
  mockIsCapacitor.mockReturnValue(false)
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
