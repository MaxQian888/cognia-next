/**
 * @jest-environment jsdom
 *
 * Focused on the shell's own logic: the per-section reset button appears in the
 * header only for sections that own AppSettings keys. Heavy children (sidebar, the ~50 dynamic
 * section components) are stubbed so the test isolates shell routing/branching.
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let mockSection = "appearance"
const replace = jest.fn()

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(`section=${mockSection}`),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// `next/dynamic` would code-split the section components; in the test we just
// render a marker so the shell's wrapper logic is what's exercised.
jest.mock("next/dynamic", () => () => {
  const Stub = ({ headerActionsTarget }: { headerActionsTarget?: HTMLElement | null }) => (
    <div
      data-testid="section-body"
      data-has-header-actions-target={String(Boolean(headerActionsTarget))}
    />
  )
  Stub.displayName = "DynamicStub"
  return Stub
})

jest.mock("./settings-sidebar", () => ({
  SettingsSidebar: () => <div data-testid="settings-sidebar" />,
}))

jest.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarInset: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarTrigger: () => <button type="button">trigger</button>,
}))

jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock("./common/section-reset-button", () => ({
  SectionResetButton: ({ sectionId }: { sectionId: string }) => (
    <button type="button" data-testid="section-reset-button">
      reset {sectionId}
    </button>
  ),
}))

const finderOpenSpy = jest.fn()
jest.mock("./finder/settings-finder", () => ({
  SettingsFinder: ({ open }: { open: boolean }) => {
    finderOpenSpy(open)
    return <div data-testid="settings-finder" data-open={open} />
  },
}))

jest.mock("@/hooks/settings/use-setting-focus", () => ({
  useSettingFocus: jest.fn(),
}))

import { SettingsShell } from "./settings-shell"

// Section reachability keys on the host profile, which `detectPlatform()`
// derives from the Tauri marker. jsdom has no marker (web-standalone), so
// anything asserting a host-backed section renders has to opt in explicitly.
const TAURI_MARKER = "__TAURI_INTERNALS__"
function setDesktop(on: boolean) {
  if (on) {
    ;(window as unknown as Record<string, unknown>)[TAURI_MARKER] = {}
  } else {
    delete (window as unknown as Record<string, unknown>)[TAURI_MARKER]
  }
}

afterEach(() => setDesktop(false))

describe("SettingsShell reset button", () => {
  beforeEach(() => {
    replace.mockClear()
  })

  it("renders the reset button in the header for a section that owns settings keys", () => {
    mockSection = "appearance"
    const { container } = render(<SettingsShell />)
    const header = container.querySelector("header")
    expect(header).toContainElement(screen.getByTestId("section-reset-button"))
    expect(screen.queryByTestId("section-reset-row")).not.toBeInTheDocument()
    expect(screen.getByTestId("section-reset-button")).toHaveTextContent("appearance")
  })

  it("omits the reset button for a Dexie-backed section with no settings keys", () => {
    mockSection = "plugins"
    render(<SettingsShell />)
    expect(screen.queryByTestId("section-reset-button")).not.toBeInTheDocument()
  })

  it("opens the finder from the header trigger", async () => {
    const user = userEvent.setup()
    mockSection = "appearance"
    render(<SettingsShell />)
    await user.click(screen.getByTestId("settings-finder-trigger"))
    expect(screen.getByTestId("settings-finder")).toHaveAttribute("data-open", "true")
  })

  it("provides AI Connections with an action target inside the header", () => {
    mockSection = "ai-connections"
    const { container } = render(<SettingsShell />)
    const target = screen.getByTestId("settings-section-header-actions")

    expect(container.querySelector("header")).toContainElement(target)
    expect(screen.getByTestId("section-body")).toHaveAttribute(
      "data-has-header-actions-target",
      "true"
    )
  })

  it("redirects the deprecated ?section=general deep link to agent-runtime", () => {
    mockSection = "general"
    render(<SettingsShell />)
    expect(replace).toHaveBeenCalledWith("/settings?section=agent-runtime", { scroll: false })
  })

  it("redirects the deprecated ?section=api-key deep link to AI Connections", () => {
    mockSection = "api-key"
    render(<SettingsShell />)
    expect(replace).toHaveBeenCalledWith("/settings?section=ai-connections", { scroll: false })
  })

  it("redirects the legacy ?section=providers deep link to AI Connections", () => {
    mockSection = "providers"
    render(<SettingsShell />)
    expect(replace).toHaveBeenCalledWith("/settings?section=ai-connections", { scroll: false })
  })

  it("redirects the merged ?section=profile deep link to account", () => {
    mockSection = "profile"
    render(<SettingsShell />)
    expect(replace).toHaveBeenCalledWith("/settings?section=account", { scroll: false })
  })

  it("mounts the Pro IDE settings section without redirecting it", () => {
    setDesktop(true)
    mockSection = "pro-ide"
    render(<SettingsShell />)
    expect(screen.getByTestId("section-body")).toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })

  it("mounts the outbound Webhooks section without a legacy Remote Control redirect", () => {
    setDesktop(true)
    mockSection = "webhooks"
    render(<SettingsShell />)
    expect(screen.getByTestId("section-body")).toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })
})

describe("SettingsShell host-reachability backstop", () => {
  beforeEach(() => {
    replace.mockClear()
  })

  it("refuses a section this host cannot reach and explains why", () => {
    setDesktop(false)
    mockSection = "subscription"
    render(<SettingsShell />)
    expect(screen.queryByTestId("section-body")).not.toBeInTheDocument()
    expect(screen.getByText("hostUnavailableSectionTitle")).toBeInTheDocument()
    expect(screen.getByText("hostUnavailableSectionBody")).toBeInTheDocument()
  })

  it("explains rather than silently redirecting — the deep link stays addressable", () => {
    setDesktop(false)
    mockSection = "ccswitch"
    render(<SettingsShell />)
    expect(replace).not.toHaveBeenCalled()
  })

  it("renders the same section normally on desktop", () => {
    setDesktop(true)
    mockSection = "subscription"
    render(<SettingsShell />)
    expect(screen.getByTestId("section-body")).toBeInTheDocument()
    expect(screen.queryByText("hostUnavailableSectionTitle")).not.toBeInTheDocument()
  })

  it("leaves sections that work in the browser alone", () => {
    setDesktop(false)
    mockSection = "appearance"
    render(<SettingsShell />)
    expect(screen.getByTestId("section-body")).toBeInTheDocument()
  })
})

describe("SettingsShell fill-height layout", () => {
  it("renders the skills section in the fixed-frame fill-height branch", () => {
    mockSection = "skills"
    const { container } = render(<SettingsShell />)
    const panel = container.querySelector("[data-settings-panel]")
    expect(panel).not.toBeNull()
    expect(panel).toHaveClass("w-full", "max-w-[100vw]", "min-w-0")
    // Fill-height branch: the panel wrapper grows to fill the frame...
    expect(panel!.className).toMatch(/\bflex-1\b/)
    // ...and never centers content behind a fixed max width.
    expect(container.innerHTML).not.toMatch(/max-w-5xl/)
  })

  // Appearance moved to a master/detail layout, so it owns its own scroll and
  // must not be width-capped.
  it("renders the appearance section in the fixed-frame fill-height branch", () => {
    mockSection = "appearance"
    const { container } = render(<SettingsShell />)
    const panel = container.querySelector("[data-settings-panel]")
    expect(panel).not.toBeNull()
    expect(panel).toHaveClass("w-full", "max-w-[100vw]", "min-w-0", "min-h-0", "overflow-hidden")
    expect(panel!.className).toMatch(/\bflex-1\b/)
    expect(container.innerHTML).not.toMatch(/max-w-5xl/)
  })

  // The three sections converted from card stacks to master/detail. Each owns
  // an internal scroller, so leaving any of them capped at max-w-5xl inside the
  // outer ScrollArea puts the scrollbar on the page instead of the pane.
  it.each(["agent-modes", "agent-runtime", "memory"] as const)(
    "renders the %s section in the fixed-frame fill-height branch",
    (section) => {
      mockSection = section
      const { container } = render(<SettingsShell />)
      const panel = container.querySelector("[data-settings-panel]")
      expect(panel).not.toBeNull()
      expect(panel!.className).toMatch(/\bflex-1\b/)
      expect(container.innerHTML).not.toMatch(/max-w-5xl/)
    }
  )

  it("keeps a plain section inside the scrollable, width-capped branch", () => {
    mockSection = "notifications"
    const { container } = render(<SettingsShell />)
    const panel = container.querySelector("[data-settings-panel]")
    expect(panel).not.toBeNull()
    expect(panel).toHaveClass("w-full", "max-w-[100vw]", "min-w-0")
    expect(panel!.className).not.toMatch(/\bflex-1\b/)
    expect(container.innerHTML).toMatch(/max-w-5xl/)
  })
})
