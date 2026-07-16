/**
 * @jest-environment jsdom
 */

import { render, screen, act } from "@testing-library/react"

jest.mock("@/hooks/ui", () => ({
  useBreakpoint: jest.fn(() => "desktop"),
}))

jest.mock("@/hooks/artifacts/use-artifact-dock-shortcuts", () => ({
  useArtifactDockShortcuts: jest.fn(),
}))

jest.mock("@/lib/ui/motion", () => ({
  mobileTransition: () => ({}),
  useReducedMotionTransition: (t: unknown) => t,
}))

// motion/react → plain divs so layout/animate props don't choke jsdom.
jest.mock("motion/react", () => ({
  motion: new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) => {
          // strip framer-only props
          const {
            layout: _l,
            animate: _a,
            transition: _t,
            ...rest
          } = props as Record<string, unknown>
          return <div {...rest}>{children}</div>
        },
    }
  ),
}))

jest.mock("./artifact-dock", () => ({
  ArtifactDock: () => <div data-testid="dock" />,
}))

jest.mock("./artifact-panel", () => ({
  ArtifactPanel: () => <div data-testid="sheet-panel" />,
}))

import { ArtifactWorkspaceDock } from "./artifact-workspace-dock"
import { useBreakpoint } from "@/hooks/ui"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"

const useBreakpointMock = useBreakpoint as jest.MockedFunction<typeof useBreakpoint>

beforeEach(() => {
  localStorage.clear()
  useBreakpointMock.mockReturnValue("desktop")
  act(() => {
    useArtifactDockLayoutStore.getState().resetLayout()
    useArtifactStore.setState({ activeArtifactId: null })
  })
})

describe("ArtifactWorkspaceDock", () => {
  it("desktop: renders children plus the dock (no Sheet)", () => {
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )
    expect(screen.getByTestId("chat")).toBeInTheDocument()
    expect(screen.getByTestId("dock")).toBeInTheDocument()
    expect(screen.queryByTestId("sheet-panel")).not.toBeInTheDocument()
  })

  it("mobile: renders children plus the Sheet fallback (no resizable dock)", () => {
    useBreakpointMock.mockReturnValue("mobile")
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )
    expect(screen.getByTestId("chat")).toBeInTheDocument()
    expect(screen.getByTestId("sheet-panel")).toBeInTheDocument()
    expect(screen.queryByTestId("artifact-workspace-dock")).not.toBeInTheDocument()
  })

  it("tablet: also uses the Sheet fallback", () => {
    useBreakpointMock.mockReturnValue("tablet")
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )
    expect(screen.getByTestId("sheet-panel")).toBeInTheDocument()
  })

  it("auto-expands the dock when a new artifact becomes active", () => {
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
    act(() => useArtifactDockLayoutStore.getState().setDockMode("workspace"))
    const { rerender } = render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )
    act(() => useArtifactStore.setState({ activeArtifactId: "a-1" }))
    rerender(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
    expect(useArtifactDockLayoutStore.getState().dockMode).toBe("artifact")
  })
})
