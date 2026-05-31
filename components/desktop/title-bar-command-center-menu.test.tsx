/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

// Inline dropdown mock — renders sub-content inline so every item is queryable.
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
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuShortcut: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  DropdownMenuSub: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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

  it("lists recent sessions and opens the chosen one", () => {
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

  it("navigates via the Go to View targets", () => {
    const { props } = setup()
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
