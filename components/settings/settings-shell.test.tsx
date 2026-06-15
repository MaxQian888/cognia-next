/**
 * @jest-environment jsdom
 *
 * Focused on the shell's own logic: the per-section reset row appears only for
 * sections that own AppSettings keys. Heavy children (sidebar, the ~50 dynamic
 * section components) are stubbed so the test isolates shell routing/branching.
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let mockSection = "general"

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
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
  it("renders the reset row for a section that owns settings keys", () => {
    mockSection = "general"
    render(<SettingsShell />)
    expect(screen.getByTestId("section-reset-row")).toBeInTheDocument()
    expect(screen.getByTestId("section-reset-button")).toHaveTextContent("general")
  })

  it("omits the reset row for a Dexie-backed section with no settings keys", () => {
    mockSection = "plugins"
    render(<SettingsShell />)
    expect(screen.queryByTestId("section-reset-row")).not.toBeInTheDocument()
  })

  it("opens the finder from the header trigger", async () => {
    const user = userEvent.setup()
    mockSection = "general"
    render(<SettingsShell />)
    await user.click(screen.getByTestId("settings-finder-trigger"))
    expect(screen.getByTestId("settings-finder")).toHaveAttribute("data-open", "true")
  })
})
