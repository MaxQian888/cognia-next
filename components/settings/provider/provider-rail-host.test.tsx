/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ProviderRailHost, type ProviderRailHostProps } from "./provider-rail-host"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

let density: "split" | "stacked" = "split"
jest.mock("@/components/settings/common/settings-master-detail", () => ({
  useSettingsListDensity: () => density,
}))

function renderHost(over: Partial<ProviderRailHostProps> = {}) {
  const props: ProviderRailHostProps = {
    rail: <div data-testid="the-rail" />,
    railWidth: 360,
    railResize: {
      dragging: false,
      onPointerDown: jest.fn(),
      onPointerMove: jest.fn(),
      onPointerUp: jest.fn(),
      onKeyDown: jest.fn(),
      onDoubleClick: jest.fn(),
    },
    sheetOpen: false,
    onSheetOpenChange: jest.fn(),
    onAdd: jest.fn(),
    ...over,
  }
  return { ...render(<ProviderRailHost {...props} />), props }
}

beforeEach(() => {
  density = "split"
})

describe("ProviderRailHost", () => {
  describe("split pane", () => {
    it("puts the rail in a resizable column", () => {
      renderHost()
      expect(screen.getByTestId("provider-rail")).toContainElement(screen.getByTestId("the-rail"))
      expect(screen.getByTestId("provider-rail-resize-handle")).toBeInTheDocument()
    })

    // The handle reports the stored PREFERENCE. The rendered track is
    // `clamp(200px, 30cqi, width)` and can be narrower on a small pane, so
    // these are deliberately two different numbers.
    it("reports the stored preference on the handle", () => {
      renderHost({ railWidth: 412 })
      const handle = screen.getByTestId("provider-rail-resize-handle")
      expect(handle).toHaveAttribute("aria-valuenow", "412")
      expect(handle).toHaveAttribute("aria-valuemin", "240")
      expect(handle).toHaveAttribute("aria-valuemax", "480")
    })

    it("offers no drawer, so there is no second copy of the rail", () => {
      renderHost()
      expect(screen.queryByTestId("provider-rail-drawer-trigger")).not.toBeInTheDocument()
      expect(screen.getAllByTestId("the-rail")).toHaveLength(1)
    })
  })

  describe("stacked pane", () => {
    beforeEach(() => {
      density = "stacked"
    })

    it("replaces the column with a top bar and no resize handle", () => {
      renderHost()
      expect(screen.getByTestId("provider-rail-bar")).toBeInTheDocument()
      expect(screen.queryByTestId("provider-rail")).not.toBeInTheDocument()
      expect(screen.queryByTestId("provider-rail-resize-handle")).not.toBeInTheDocument()
    })

    // The rail lives ONLY inside the closed drawer here. Rendering a
    // CSS-hidden second copy would duplicate every `id="provider-<id>"` the
    // onboarding banner scrolls to with getElementById.
    it("keeps the rail out of the document until the drawer opens", () => {
      renderHost()
      expect(screen.queryByTestId("the-rail")).not.toBeInTheDocument()
    })

    it("shows exactly one rail once the drawer is open", () => {
      renderHost({ sheetOpen: true })
      expect(screen.getAllByTestId("the-rail")).toHaveLength(1)
    })

    it("names the selected provider on the bar", () => {
      renderHost({ selectedName: "OpenAI" })
      expect(screen.getByTestId("provider-rail-title")).toHaveTextContent("OpenAI")
    })

    it("omits the title when nothing is selected", () => {
      renderHost()
      expect(screen.queryByTestId("provider-rail-title")).not.toBeInTheDocument()
    })

    it("opens the drawer from the bar", async () => {
      const onSheetOpenChange = jest.fn()
      const user = userEvent.setup()
      renderHost({ onSheetOpenChange })
      await user.click(screen.getByTestId("provider-rail-drawer-trigger"))
      expect(onSheetOpenChange).toHaveBeenCalledWith(true)
    })

    // Adding is on the bar itself. Having to open the drawer first would be a
    // tap of pure ceremony.
    it("adds a provider without opening the drawer", async () => {
      const onAdd = jest.fn()
      const onSheetOpenChange = jest.fn()
      const user = userEvent.setup()
      renderHost({ onAdd, onSheetOpenChange })
      await user.click(screen.getByTestId("provider-rail-drawer-add"))
      expect(onAdd).toHaveBeenCalledTimes(1)
      expect(onSheetOpenChange).not.toHaveBeenCalled()
    })
  })
})
