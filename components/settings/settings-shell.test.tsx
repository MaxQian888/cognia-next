/**
 * @jest-environment jsdom
 *
 * Focused on the shell's own logic: the per-section reset row appears only for
 * sections that own AppSettings keys. Heavy children (sidebar, the ~50 dynamic
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
  const Stub = () => <div data-testid="section-body" />
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

describe("SettingsShell reset row", () => {
  beforeEach(() => {
    replace.mockClear()
  })

  it("renders the reset row for a section that owns settings keys", () => {
    mockSection = "appearance"
    render(<SettingsShell />)
    expect(screen.getByTestId("section-reset-row")).toBeInTheDocument()
    expect(screen.getByTestId("section-reset-button")).toHaveTextContent("appearance")
  })

  it("omits the reset row for a Dexie-backed section with no settings keys", () => {
    mockSection = "plugins"
    render(<SettingsShell />)
    expect(screen.queryByTestId("section-reset-row")).not.toBeInTheDocument()
  })

  it("opens the finder from the header trigger", async () => {
    const user = userEvent.setup()
    mockSection = "appearance"
    render(<SettingsShell />)
    await user.click(screen.getByTestId("settings-finder-trigger"))
    expect(screen.getByTestId("settings-finder")).toHaveAttribute("data-open", "true")
  })

  it("redirects the deprecated ?section=general deep link to agent-runtime", () => {
    mockSection = "general"
    render(<SettingsShell />)
    expect(replace).toHaveBeenCalledWith("/settings?section=agent-runtime", { scroll: false })
  })

  it("redirects the deprecated ?section=api-key deep link to providers", () => {
    mockSection = "api-key"
    render(<SettingsShell />)
    expect(replace).toHaveBeenCalledWith("/settings?section=providers", { scroll: false })
  })

  it("redirects the merged ?section=profile deep link to account", () => {
    mockSection = "profile"
    render(<SettingsShell />)
    expect(replace).toHaveBeenCalledWith("/settings?section=account", { scroll: false })
  })
})

describe("SettingsShell fill-height layout", () => {
  it("renders the skills section in the fixed-frame fill-height branch", () => {
    mockSection = "skills"
    const { container } = render(<SettingsShell />)
    const panel = container.querySelector("[data-settings-panel]")
    expect(panel).not.toBeNull()
    // Fill-height branch: the panel wrapper grows to fill the frame...
    expect(panel!.className).toMatch(/\bflex-1\b/)
    // ...and never centers content behind a fixed max width.
    expect(container.innerHTML).not.toMatch(/max-w-5xl/)
  })

  it("keeps a plain section inside the scrollable, width-capped branch", () => {
    mockSection = "appearance"
    const { container } = render(<SettingsShell />)
    const panel = container.querySelector("[data-settings-panel]")
    expect(panel).not.toBeNull()
    expect(panel!.className).not.toMatch(/\bflex-1\b/)
    expect(container.innerHTML).toMatch(/max-w-5xl/)
  })
})
