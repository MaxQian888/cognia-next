/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ShellLayoutCustomizer, SHELL_SURFACES } from "./shell-layout-customizer"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useSettingsStore } from "@/stores/settings/settings-store"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => "tauri" }))

beforeEach(() => {
  useSettingsStore.setState({ settings: {} as never, save: (async () => {}) as never })
})

const renderCustomizer = (props?: React.ComponentProps<typeof ShellLayoutCustomizer>) =>
  render(
    <TooltipProvider>
      <ShellLayoutCustomizer {...props} />
    </TooltipProvider>
  )

describe("ShellLayoutCustomizer", () => {
  it("lists the shell surfaces, workbench beside the nav rail", () => {
    // Order is the tab order. The two icon columns sit side by side on the same
    // window edge now, so their editors are adjacent rather than split by the
    // window bars.
    expect(SHELL_SURFACES).toEqual(["sidebar", "workbench", "title", "status"])
  })

  it("defaults to the nav rail", () => {
    renderCustomizer()
    expect(screen.getByTestId("sidebar-customizer")).toBeInTheDocument()
    expect(screen.queryByTestId("bar-customizer-title")).toBeNull()
  })

  it("opens on the requested surface", () => {
    renderCustomizer({ defaultSurface: "status" })
    expect(screen.getByTestId("bar-customizer-status")).toBeInTheDocument()
    expect(screen.queryByTestId("sidebar-customizer")).toBeNull()
  })

  it("switches tabs on its own", async () => {
    const user = userEvent.setup()
    renderCustomizer()
    await user.click(screen.getByTestId("shell-layout-tab-status"))
    expect(await screen.findByTestId("bar-customizer-status")).toBeInTheDocument()
  })

  it("keeps the chosen tab when the caller re-renders with the same default", async () => {
    const user = userEvent.setup()
    const { rerender } = renderCustomizer({ defaultSurface: "sidebar" })
    await user.click(screen.getByTestId("shell-layout-tab-title"))
    rerender(
      <TooltipProvider>
        <ShellLayoutCustomizer defaultSurface="sidebar" />
      </TooltipProvider>
    )
    expect(screen.getByTestId("bar-customizer-title")).toBeInTheDocument()
  })
})
