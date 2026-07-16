/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/stores/chat", () => ({
  useChatStore: (selector: (state: { activeSessionId: string }) => unknown) =>
    selector({ activeSessionId: "session-1" }),
}))
jest.mock("@/components/ui/sheet", () => ({
  Sheet: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    children: React.ReactNode
  }) =>
    open ? (
      <div data-testid="sheet-root">
        {children}
        <button data-testid="close-sheet" onClick={() => onOpenChange(false)} />
      </div>
    ) : null,
  SheetContent: ({
    children,
    showCloseButton: _showCloseButton,
    ...props
  }: React.ComponentProps<"div"> & { showCloseButton?: boolean }) => (
    <div {...props}>{children}</div>
  ),
  SheetClose: ({
    children,
    asChild: _asChild,
  }: {
    children: React.ReactNode
    asChild?: boolean
  }) => <>{children}</>,
  SheetTitle: ({ children, ...props }: React.ComponentProps<"h2">) => (
    <h2 {...props}>{children}</h2>
  ),
}))
jest.mock("./dock-workspace", () => ({
  DockWorkspace: ({
    activeSessionId,
    layout,
  }: {
    activeSessionId: string | null
    layout: string
  }) => (
    <div data-testid="mobile-dock-workspace" data-session={activeSessionId} data-layout={layout} />
  ),
}))

import { MobileWorkspaceSheet } from "./mobile-workspace-sheet"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"

beforeEach(() => {
  act(() => useArtifactDockLayoutStore.getState().resetLayout())
})

it("opens only for Workspace mode and reuses the responsive DockWorkspace", () => {
  act(() => {
    useArtifactDockLayoutStore.getState().setDockMode("workspace")
    useArtifactDockLayoutStore.getState().setMobileSheetOpen(true)
  })

  render(<MobileWorkspaceSheet />)

  expect(screen.getByTestId("mobile-workspace-sheet")).toBeInTheDocument()
  expect(screen.getByTestId("mobile-dock-workspace")).toHaveAttribute("data-session", "session-1")
  expect(screen.getByTestId("mobile-dock-workspace")).toHaveAttribute("data-layout", "mobile")
})

it("closes through the shared runtime sheet state", () => {
  act(() => {
    useArtifactDockLayoutStore.getState().revealWorkspaceFile({
      sessionId: "session-1",
      rootPath: "/repo",
      relPath: "src/a.ts",
    })
  })
  render(<MobileWorkspaceSheet />)

  fireEvent.click(screen.getByTestId("close-sheet"))

  expect(useArtifactDockLayoutStore.getState().mobileSheetOpen).toBe(false)
  expect(useArtifactDockLayoutStore.getState().workspaceRevealRequest).toBeNull()
  expect(useArtifactDockLayoutStore.getState().workspaceContext).toBeNull()
})
