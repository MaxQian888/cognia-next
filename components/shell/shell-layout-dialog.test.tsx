/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { ShellLayoutDialog } from "./shell-layout-dialog"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useSettingsStore } from "@/stores/settings/settings-store"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => "tauri" }))

beforeEach(() => {
  useSettingsStore.setState({ settings: {} as never, save: (async () => {}) as never })
})

const renderDialog = (props: Partial<React.ComponentProps<typeof ShellLayoutDialog>> = {}) =>
  render(
    <TooltipProvider>
      <ShellLayoutDialog open onOpenChange={jest.fn()} {...props} />
    </TooltipProvider>
  )

describe("ShellLayoutDialog", () => {
  it("renders the customizer when open, on the nav rail by default", () => {
    renderDialog()
    expect(screen.getByTestId("shell-layout-dialog")).toBeInTheDocument()
    expect(screen.getByTestId("sidebar-customizer")).toBeInTheDocument()
  })

  it("opens on the surface the entry point asked for", () => {
    renderDialog({ surface: "status" })
    expect(screen.getByTestId("bar-customizer-status")).toBeInTheDocument()
  })

  it("re-opening from another entry point lands on that entry point's surface", () => {
    const { rerender } = render(
      <TooltipProvider>
        <ShellLayoutDialog open={false} onOpenChange={jest.fn()} surface="status" />
      </TooltipProvider>
    )
    rerender(
      <TooltipProvider>
        <ShellLayoutDialog open onOpenChange={jest.fn()} surface="title" />
      </TooltipProvider>
    )
    expect(screen.getByTestId("bar-customizer-title")).toBeInTheDocument()
  })

  it("renders nothing while closed", () => {
    renderDialog({ open: false })
    expect(screen.queryByTestId("shell-layout-dialog")).toBeNull()
  })
})
