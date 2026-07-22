/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

const saveMock = jest.fn(async (_patch: Record<string, unknown>): Promise<void> => undefined)
const enqueueMock = jest.fn(async (_arg: unknown): Promise<void> => undefined)

// `SubPageShell` pops history instead of pushing `/me`, falling back to
// `replace(backHref)` when there is nothing to pop — assert against the real
// router rather than the global jest.setup stub (which hands out a fresh
// `jest.fn()` on every call).
const routerBackMock = jest.fn()
const routerReplaceMock = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({
    back: routerBackMock,
    replace: routerReplaceMock,
    push: jest.fn(),
    prefetch: jest.fn(),
  }),
  usePathname: () => "/me/web-search",
  useSearchParams: () => new URLSearchParams(),
}))

const settingsRef: { current: Record<string, unknown> | undefined } = {
  current: { searchEnabled: false, searchMaxResults: 10 },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (
    selector: (s: {
      settings: Record<string, unknown> | undefined
      save: (patch: Record<string, unknown>) => Promise<void>
    }) => unknown
  ) =>
    selector({
      settings: settingsRef.current,
      save: async (patch: Record<string, unknown>) => {
        if (settingsRef.current) settingsRef.current = { ...settingsRef.current, ...patch }
        await saveMock(patch)
      },
    }),
}))

jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: (arg: unknown) => enqueueMock(arg),
}))

const standaloneRef = { current: false }
jest.mock("@/lib/runtime/standalone-mode", () => ({
  isStandaloneChatMode: () => standaloneRef.current,
}))

jest.mock("@/components/mobile/me/search-provider-key-list", () => ({
  SearchProviderKeyList: () => <div data-testid="me-section-search-keys" />,
}))

// Render the Radix Select as a native <select> so `onValueChange` is testable.
jest.mock("@/components/ui/select", () => {
  const React = jest.requireActual("react")
  const collect = (nodes: unknown, items: unknown[], meta: { label?: string; testid?: string }) => {
    React.Children.forEach(
      nodes,
      (child: { type?: { __isItem?: boolean }; props?: Record<string, unknown> }) => {
        if (!child || typeof child !== "object" || !child.props) return
        if (child.props["aria-label"]) meta.label = child.props["aria-label"] as string
        if (child.props["data-testid"]) meta.testid = child.props["data-testid"] as string
        if (child.type?.__isItem) items.push(child)
        else if (child.props.children) collect(child.props.children, items, meta)
      }
    )
  }
  const Select = ({ value, onValueChange, disabled, children }: Record<string, unknown>) => {
    const items: { props: { value: string; children: unknown } }[] = []
    const meta: { label?: string; testid?: string } = {}
    collect(children, items as unknown[], meta)
    return React.createElement(
      "select",
      {
        "aria-label": meta.label,
        "data-testid": meta.testid,
        value,
        disabled,
        onChange: (e: { target: { value: string } }) =>
          (onValueChange as (v: string) => void)(e.target.value),
      },
      items.map((it) =>
        React.createElement(
          "option",
          { key: it.props.value, value: it.props.value },
          it.props.children
        )
      )
    )
  }
  const SelectTrigger = () => null
  const SelectValue = () => null
  const SelectContent = ({ children }: { children: unknown }) => children
  const SelectItem = (props: unknown) => props
  ;(SelectItem as { __isItem?: boolean }).__isItem = true
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem }
})

import Page from "./page"

beforeEach(() => {
  saveMock.mockReset()
  enqueueMock.mockReset()
  routerBackMock.mockReset()
  routerReplaceMock.mockReset()
  settingsRef.current = { searchEnabled: false, searchMaxResults: 10 }
  standaloneRef.current = false
})

describe("MobileWebSearchPage", () => {
  it("renders the toggle + result-count controls inside the shell", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-web-search-page")).toBeInTheDocument()
    expect(screen.getByTestId("web-search-enabled")).toBeInTheDocument()
    expect(screen.getByTestId("web-search-max-results")).toBeInTheDocument()
  })

  it("routes the back button to /me", () => {
    // Cold start straight on the sub-page: nothing to pop, so the shell
    // replaces with the configured backHref — the page relies on the `/me`
    // default.
    const lengthSpy = jest.spyOn(window.history, "length", "get").mockReturnValue(1)
    try {
      render(<Page />)
      fireEvent.click(screen.getByTestId("mobile-sub-page-back"))
      expect(routerReplaceMock).toHaveBeenCalledWith("/me")
      expect(routerBackMock).not.toHaveBeenCalled()
    } finally {
      lengthSpy.mockRestore()
    }
  })

  it("disables the result-count picker until search is enabled", () => {
    render(<Page />)
    expect(screen.getByTestId("web-search-max-results")).toBeDisabled()
  })

  it("toggling search persists and enqueues a server-bound update", async () => {
    render(<Page />)
    fireEvent.click(screen.getByTestId("web-search-enabled"))
    await Promise.resolve()
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ searchEnabled: true })
    expect(enqueueMock).toHaveBeenCalled()
  })

  it("changing the result count persists a numeric value", async () => {
    settingsRef.current = { searchEnabled: true, searchMaxResults: 10 }
    render(<Page />)
    fireEvent.change(screen.getByTestId("web-search-max-results"), { target: { value: "20" } })
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ searchMaxResults: 20 })
  })

  it("renders the preferred-provider picker and fallback toggle", () => {
    render(<Page />)
    expect(screen.getByTestId("web-search-provider")).toBeInTheDocument()
    expect(screen.getByTestId("web-search-fallback")).toBeInTheDocument()
  })

  it("changing the preferred provider persists defaultSearchProvider", async () => {
    settingsRef.current = { searchEnabled: true, searchMaxResults: 10 }
    render(<Page />)
    fireEvent.change(screen.getByTestId("web-search-provider"), { target: { value: "exa" } })
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ defaultSearchProvider: "exa" })
  })

  it("toggling the fallback persists searchFallbackEnabled", async () => {
    settingsRef.current = { searchEnabled: true, searchFallbackEnabled: true }
    render(<Page />)
    fireEvent.click(screen.getByTestId("web-search-fallback"))
    await Promise.resolve()
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ searchFallbackEnabled: false })
  })

  it("disables the provider + fallback until search is enabled", () => {
    render(<Page />)
    expect(screen.getByTestId("web-search-provider")).toBeDisabled()
    expect(screen.getByTestId("web-search-fallback")).toBeDisabled()
  })

  it("falls back to disabled + default count when settings are absent", () => {
    settingsRef.current = undefined
    render(<Page />)
    expect(screen.getByTestId("web-search-enabled")).not.toBeChecked()
    expect(screen.getByTestId("web-search-max-results")).toBeDisabled()
  })

  it("hides the provider-key section in paired mode", () => {
    standaloneRef.current = false
    render(<Page />)
    expect(screen.queryByTestId("me-section-search-keys")).not.toBeInTheDocument()
  })

  it("shows the provider-key section in standalone mode", () => {
    standaloneRef.current = true
    render(<Page />)
    expect(screen.getByTestId("me-section-search-keys")).toBeInTheDocument()
  })
})
