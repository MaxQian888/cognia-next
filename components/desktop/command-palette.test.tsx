/**
 * @jest-environment jsdom
 */
import { render } from "@testing-library/react"

const push = jest.fn()
// One router object, as Next's own hook returns a stable instance.
jest.mock("next/navigation", () => {
  const router = { push: (...args: unknown[]) => push(...args) }
  return { useRouter: () => router }
})

const dialogProps: Array<{ host: { onOpenSettings: (tab?: string, focus?: string) => void } }> = []
jest.mock("@/components/global-search/global-search-dialog", () => ({
  GlobalSearchDialog: (props: (typeof dialogProps)[number]) => {
    dialogProps.push(props)
    return <div data-testid="global-search-dialog-stub" />
  },
}))

import { CommandPalette } from "./command-palette"

describe("CommandPalette (desktop adapter)", () => {
  beforeEach(() => {
    dialogProps.length = 0
    push.mockClear()
  })

  it("mounts the unified dialog with a settings host", () => {
    const onOpenSettings = jest.fn()
    const { getByTestId } = render(<CommandPalette onOpenSettings={onOpenSettings} />)
    expect(getByTestId("global-search-dialog-stub")).toBeInTheDocument()
    expect(dialogProps).toHaveLength(1)
    dialogProps[0]!.host.onOpenSettings("mcp")
    expect(onOpenSettings).toHaveBeenCalledWith("mcp")
    dialogProps[0]!.host.onOpenSettings()
    expect(onOpenSettings).toHaveBeenLastCalledWith(undefined)
    expect(push).not.toHaveBeenCalled()
  })

  it("deep-links a focused settings control through the router", () => {
    const onOpenSettings = jest.fn()
    render(<CommandPalette onOpenSettings={onOpenSettings} />)
    dialogProps[0]!.host.onOpenSettings("appearance", "language")
    expect(push).toHaveBeenCalledWith("/settings?section=appearance&focus=language")
    expect(onOpenSettings).not.toHaveBeenCalled()
  })

  it("keeps the host identity stable across re-renders", () => {
    const onOpenSettings = jest.fn()
    const { rerender } = render(<CommandPalette onOpenSettings={onOpenSettings} />)
    rerender(<CommandPalette onOpenSettings={onOpenSettings} />)
    expect(dialogProps[0]!.host).toBe(dialogProps[1]!.host)
  })
})
