/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

// Flat inline dropdown mock — the real component no longer uses submenus, so we
// only need the primitives it renders directly.
jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <button>{children}</button>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    ...rest
  }: React.HTMLAttributes<HTMLDivElement> & { onSelect?: () => void; disabled?: boolean }) => (
    <div
      role="menuitem"
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled) onSelect?.()
      }}
      {...rest}
    >
      {children}
    </div>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuShortcut: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

import { TitleBarCommandCenterMenu } from "./title-bar-command-center-menu"

function setup(overrides: Partial<React.ComponentProps<typeof TitleBarCommandCenterMenu>> = {}) {
  const props: React.ComponentProps<typeof TitleBarCommandCenterMenu> = {
    recentSessions: [
      { id: "s1", title: "First chat" },
      { id: "s2", title: "Second chat" },
    ],
    onCommandPalette: jest.fn(),
    onOpenRecentSession: jest.fn(),
    onGo: jest.fn(),
    ...overrides,
  }
  return { props, ...render(<TitleBarCommandCenterMenu {...props} />) }
}

describe("TitleBarCommandCenterMenu", () => {
  it("opens the command palette from the first item", () => {
    const { props } = setup()
    fireEvent.click(screen.getByTestId("cc-command-palette"))
    expect(props.onCommandPalette).toHaveBeenCalled()
  })

  it("lists recent sessions inline and opens the chosen one", () => {
    const { props } = setup()
    fireEvent.click(screen.getByTestId("cc-recent-s2"))
    expect(props.onOpenRecentSession).toHaveBeenCalledWith("s2")
  })

  it("shows a disabled placeholder when there are no recent sessions", () => {
    setup({ recentSessions: [] })
    expect(screen.getByText("desktop.titleBar.commandCenter.noRecent")).toBeInTheDocument()
  })

  it("falls back to an Untitled label for sessions without a title", () => {
    setup({ recentSessions: [{ id: "s3", title: "" }] })
    expect(screen.getByText("desktop.titleBar.commandCenter.untitled")).toBeInTheDocument()
  })

  it("caps the inline recent list at six entries", () => {
    setup({
      recentSessions: Array.from({ length: 9 }, (_, i) => ({
        id: `r${i}`,
        title: `Chat ${i}`,
      })),
    })
    // r0..r5 render; r6..r8 are dropped by the MAX_RECENT slice.
    expect(screen.getByTestId("cc-recent-r5")).toBeInTheDocument()
    expect(screen.queryByTestId("cc-recent-r6")).not.toBeInTheDocument()
  })

  it("renders every curated Go to View target", () => {
    const { props } = setup()
    for (const id of [
      "go-inbox",
      "go-workflows",
      "go-agent-teams",
      "go-scheduler",
      "go-discover",
      "go-plugins",
      "go-settings",
    ]) {
      expect(screen.getByTestId(`cc-go-${id}`)).toBeInTheDocument()
    }
    fireEvent.click(screen.getByTestId("cc-go-go-scheduler"))
    expect(props.onGo).toHaveBeenCalledWith("go-scheduler")
  })

  it("exposes an accessible caret trigger", () => {
    setup()
    expect(screen.getByTestId("title-bar-command-center-menu")).toHaveAttribute(
      "aria-label",
      "desktop.titleBar.commandCenter.menuLabel"
    )
  })
})
