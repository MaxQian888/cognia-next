/**
 * @jest-environment jsdom
 */
import { render } from "@testing-library/react"

const push = jest.fn()
const pathnameRef = { current: "/settings" as string | null }
jest.mock("next/navigation", () => {
  const router = { push: (...args: unknown[]) => push(...args) }
  return { useRouter: () => router, usePathname: () => pathnameRef.current }
})

const dialogProps: Array<{ host: { onOpenSettings: (tab?: string, focus?: string) => void } }> = []
jest.mock("@/components/global-search/global-search-dialog", () => ({
  GlobalSearchDialog: (props: (typeof dialogProps)[number]) => {
    dialogProps.push(props)
    return <div data-testid="global-search-dialog-stub" />
  },
}))

import { MobileGlobalSearchHost } from "./mobile-global-search-host"

describe("MobileGlobalSearchHost", () => {
  beforeEach(() => {
    dialogProps.length = 0
    push.mockClear()
    pathnameRef.current = "/settings"
  })

  it("mounts the dialog on routes the home shell does not cover", () => {
    const { getByTestId } = render(<MobileGlobalSearchHost />)
    expect(getByTestId("global-search-dialog-stub")).toBeInTheDocument()
    dialogProps[0]!.host.onOpenSettings("mcp")
    expect(push).toHaveBeenCalledWith("/settings?section=mcp")
    dialogProps[0]!.host.onOpenSettings()
    expect(push).toHaveBeenLastCalledWith("/settings")
    // A focused control degrades to its section on mobile.
    dialogProps[0]!.host.onOpenSettings("appearance", "language")
    expect(push).toHaveBeenLastCalledWith("/settings?section=appearance")
  })

  it("stays out of the way on / where AppShellMobile owns the mount", () => {
    pathnameRef.current = "/"
    const { container } = render(<MobileGlobalSearchHost />)
    expect(container).toBeEmptyDOMElement()
    expect(dialogProps).toHaveLength(0)
  })

  it("treats a null pathname as the home route", () => {
    pathnameRef.current = null
    const { container } = render(<MobileGlobalSearchHost />)
    expect(container).toBeEmptyDOMElement()
  })

  it("keeps the host identity stable across re-renders", () => {
    const { rerender } = render(<MobileGlobalSearchHost />)
    rerender(<MobileGlobalSearchHost />)
    expect(dialogProps[0]!.host).toBe(dialogProps[1]!.host)
  })
})
