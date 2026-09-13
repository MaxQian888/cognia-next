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
    detail: <div data-testid="the-detail" />,
    railWidth: 360,
    railResize: {
      dragging: false,
      onPointerDown: jest.fn(),
      onPointerMove: jest.fn(),
      onPointerUp: jest.fn(),
      onKeyDown: jest.fn(),
      onDoubleClick: jest.fn(),
    },
    stackedView: "list",
    onShowList: jest.fn(),
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
    it("puts the rail in a resizable column beside the detail", () => {
      renderHost()
      expect(screen.getByTestId("provider-rail")).toContainElement(screen.getByTestId("the-rail"))
      expect(screen.getByTestId("provider-rail-resize-handle")).toBeInTheDocument()
      expect(screen.getByTestId("the-detail")).toBeInTheDocument()
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

    it("ignores the stacked view: both columns stay live", () => {
      renderHost({ stackedView: "detail" })
      expect(screen.getAllByTestId("the-rail")).toHaveLength(1)
      expect(screen.getByTestId("the-detail")).toBeInTheDocument()
      expect(screen.queryByTestId("provider-rail-bar")).not.toBeInTheDocument()
    })
  })

  describe("stacked pane", () => {
    beforeEach(() => {
      density = "stacked"
    })

    // The rail's rows carry `id="provider-<id>"` which the onboarding banner
    // scrolls to with getElementById; a second CSS-hidden copy would break it.
    it("shows the list as the whole page, with the detail unmounted", () => {
      renderHost({ stackedView: "list" })
      const rail = screen.getByTestId("provider-rail")
      expect(rail).toHaveAttribute("data-stacked-view", "list")
      expect(rail).toHaveClass("row-span-2")
      expect(screen.getAllByTestId("the-rail")).toHaveLength(1)
      expect(screen.queryByTestId("the-detail")).not.toBeInTheDocument()
      expect(screen.queryByTestId("provider-rail-bar")).not.toBeInTheDocument()
      expect(screen.queryByTestId("provider-rail-resize-handle")).not.toBeInTheDocument()
    })

    it("pushes the detail in under a bar and takes the list out", () => {
      renderHost({ stackedView: "detail", selectedName: "OpenAI" })
      expect(screen.getByTestId("provider-rail-bar")).toHaveAttribute("data-stacked-view", "detail")
      expect(screen.getByTestId("the-detail")).toBeInTheDocument()
      expect(screen.queryByTestId("the-rail")).not.toBeInTheDocument()
      expect(screen.getByTestId("provider-rail-title")).toHaveTextContent("OpenAI")
    })

    it("omits the title when nothing is named", () => {
      renderHost({ stackedView: "detail" })
      expect(screen.queryByTestId("provider-rail-title")).not.toBeInTheDocument()
    })

    it("returns to the list from the bar's back button", async () => {
      const onShowList = jest.fn()
      const user = userEvent.setup()
      renderHost({ stackedView: "detail", onShowList })
      await user.click(screen.getByTestId("provider-rail-back"))
      expect(onShowList).toHaveBeenCalledTimes(1)
    })

    // Adding is on the bar itself. Going back to the list first would be a
    // tap of pure ceremony.
    it("adds a provider from the detail bar without leaving it", async () => {
      const onAdd = jest.fn()
      const onShowList = jest.fn()
      const user = userEvent.setup()
      renderHost({ stackedView: "detail", onAdd, onShowList })
      await user.click(screen.getByTestId("provider-rail-drawer-add"))
      expect(onAdd).toHaveBeenCalledTimes(1)
      expect(onShowList).not.toHaveBeenCalled()
    })
  })
})
