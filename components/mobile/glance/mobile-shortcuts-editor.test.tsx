/**
 * @jest-environment jsdom
 */

import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DEFAULT_GLANCE_MOBILE_SHORTCUTS } from "@/lib/glance/mobile-layout"
import { MOBILE_QUICK_ACTION_CATALOG } from "@/types/shell/mobile-home"

import { MobileShortcutsEditor } from "./mobile-shortcuts-editor"

const ROW_HEIGHT = 44

function renderEditor(shortcuts: readonly string[]) {
  const onChange = jest.fn<void, [string[]]>()
  const view = render(<MobileShortcutsEditor shortcuts={shortcuts} onChange={onChange} />)
  return { onChange, ...view }
}

function activeIds(): string[] {
  return screen
    .queryAllByTestId(/^mobile-shortcuts-active-/)
    .map((el) => el.getAttribute("data-testid")?.replace("mobile-shortcuts-active-", "") ?? "")
}

function availableIds(): string[] {
  return screen
    .queryAllByTestId(/^mobile-shortcuts-available-/)
    .map((el) => el.getAttribute("data-testid")?.replace("mobile-shortcuts-available-", "") ?? "")
}

describe("MobileShortcutsEditor", () => {
  it("lists the active shortcuts in their stored order, each with a named drag handle", () => {
    renderEditor(["workflows", "newChat", "me"])
    expect(activeIds()).toEqual(["workflows", "newChat", "me"])
    expect(screen.getByRole("heading", { name: "In the grid" })).toBeInTheDocument()
    expect(screen.getByText("Drag to reorder")).toBeInTheDocument()
    const handle = screen.getByTestId("mobile-shortcuts-handle-workflows")
    expect(handle).toHaveAccessibleName("Reorder Workflows")
    expect(screen.getByRole("button", { name: "Reorder New chat" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reorder Me" })).toBeInTheDocument()
    expect(
      within(screen.getByTestId("mobile-shortcuts-active-newChat")).getByText("New chat")
    ).toBeInTheDocument()
  })

  it("lists every other catalogue shortcut as available, in catalogue order", () => {
    renderEditor(["workflows", "newChat"])
    expect(availableIds()).toEqual(
      MOBILE_QUICK_ACTION_CATALOG.map((a) => a.id).filter(
        (id) => id !== "workflows" && id !== "newChat"
      )
    )
    expect(screen.getByRole("heading", { name: "Add shortcuts" })).toBeInTheDocument()
  })

  it("removes a shortcut, handing back the list without it", async () => {
    const user = userEvent.setup()
    const { onChange } = renderEditor(["newChat", "search", "workflows"])
    await user.click(screen.getByRole("button", { name: "Remove Search" }))
    expect(onChange).toHaveBeenCalledWith(["newChat", "workflows"])
  })

  it("adds an available shortcut to the end", async () => {
    const user = userEvent.setup()
    const { onChange } = renderEditor(["newChat", "search"])
    await user.click(screen.getByRole("button", { name: "Add Devices" }))
    expect(onChange).toHaveBeenCalledWith(["newChat", "search", "devices"])
  })

  it("resets to the default four, and is disabled when already default", async () => {
    const user = userEvent.setup()
    const { onChange, unmount } = renderEditor(["me"])
    const reset = screen.getByTestId("mobile-shortcuts-reset")
    expect(reset).toHaveTextContent("Restore defaults")
    expect(reset).toBeEnabled()
    await user.click(reset)
    expect(onChange).toHaveBeenCalledWith([...DEFAULT_GLANCE_MOBILE_SHORTCUTS])
    // A fresh copy: the editor never hands out the shared default array.
    expect(onChange.mock.calls[0][0]).not.toBe(DEFAULT_GLANCE_MOBILE_SHORTCUTS)
    unmount()

    renderEditor(DEFAULT_GLANCE_MOBILE_SHORTCUTS)
    expect(screen.getByTestId("mobile-shortcuts-reset")).toBeDisabled()
  })

  it("is not default when the default ids are in another order", () => {
    renderEditor([...DEFAULT_GLANCE_MOBILE_SHORTCUTS].reverse())
    expect(screen.getByTestId("mobile-shortcuts-reset")).toBeEnabled()
  })

  it("says so when no shortcut is active", () => {
    renderEditor([])
    expect(screen.getByText("No shortcuts — add some below.")).toBeInTheDocument()
    expect(activeIds()).toEqual([])
    expect(availableIds()).toHaveLength(MOBILE_QUICK_ACTION_CATALOG.length)
  })

  it("says so when every shortcut is active", () => {
    renderEditor(MOBILE_QUICK_ACTION_CATALOG.map((a) => a.id))
    expect(screen.getByText("Every shortcut is in the grid.")).toBeInTheDocument()
    expect(availableIds()).toEqual([])
  })

  it("shows the renamed agentTeams id as Squads, and drops unknown ids", async () => {
    const user = userEvent.setup()
    const { onChange } = renderEditor(["agentTeams", "nope", "search"])
    expect(activeIds()).toEqual(["squads", "search"])
    expect(screen.getByRole("button", { name: "Reorder Squads" })).toBeInTheDocument()
    expect(availableIds()).not.toContain("squads")
    // An edit writes the current id back, so the legacy one does not linger.
    await user.click(screen.getByRole("button", { name: "Remove Search" }))
    expect(onChange).toHaveBeenCalledWith(["squads"])
  })

  describe("keyboard reorder", () => {
    // jsdom has no layout: dnd-kit picks the neighbour by measured position, so
    // lay the active rows out as a 44px column.
    let rectSpy: jest.SpyInstance

    beforeEach(() => {
      rectSpy = jest
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockImplementation(function (this: HTMLElement) {
          const id = this.getAttribute("data-testid") ?? ""
          let top = 0
          if (id.startsWith("mobile-shortcuts-active-")) {
            const siblings = Array.from(this.parentElement?.children ?? [])
            top = siblings.indexOf(this) * ROW_HEIGHT
          }
          return {
            x: 0,
            y: top,
            top,
            left: 0,
            right: 300,
            bottom: top + ROW_HEIGHT,
            width: 300,
            height: ROW_HEIGHT,
            toJSON: () => ({}),
          }
        })
    })

    afterEach(() => rectSpy.mockRestore())

    it("moves a shortcut down with Space, ArrowDown, Space on its handle", async () => {
      const user = userEvent.setup()
      const { onChange } = renderEditor(["newChat", "search", "workflows"])
      screen.getByRole("button", { name: "Reorder New chat" }).focus()
      await user.keyboard(" ")
      await user.keyboard("{ArrowDown}")
      await user.keyboard(" ")
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(onChange).toHaveBeenCalledWith(["search", "newChat", "workflows"])
    })

    it("changes nothing when dropped where it started", async () => {
      const user = userEvent.setup()
      const { onChange } = renderEditor(["newChat", "search"])
      screen.getByRole("button", { name: "Reorder Search" }).focus()
      await user.keyboard(" ")
      await user.keyboard(" ")
      expect(onChange).not.toHaveBeenCalled()
    })
  })
})
