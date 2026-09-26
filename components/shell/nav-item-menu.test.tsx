/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DROPDOWN_MENU_KIT } from "@/components/shared/menu-kit"
import { NavItemContextMenu, NavItemMenuItems } from "./nav-item-menu"
import type { NavDragBinding } from "./nav-sortable"
import type { ShellNavItemMenu } from "./use-shell-nav"

function actions(over: Partial<ShellNavItemMenu> = {}): ShellNavItemMenu {
  return {
    canMoveUp: true,
    canMoveDown: true,
    onMove: jest.fn(),
    onHide: jest.fn(),
    onCustomize: jest.fn(),
    ...over,
  }
}

const drag = (over: Partial<NavDragBinding> = {}): NavDragBinding => ({
  setNodeRef: jest.fn(),
  style: {},
  dragging: false,
  handleProps: { "aria-roledescription": "sortable" },
  ...over,
})

function openMenu(menu: ShellNavItemMenu, binding = drag()) {
  render(
    <NavItemContextMenu drag={binding} menuTestId="nav-menu" {...menu}>
      <button type="button" data-testid="item">
        Inbox
      </button>
    </NavItemContextMenu>
  )
  fireEvent.contextMenu(screen.getByTestId("item"))
}

describe("NavItemContextMenu", () => {
  it("offers move, move to More, hide and customize for a pinned feature", () => {
    const menu = actions({ onMoveToMore: jest.fn() })
    openMenu(menu)
    expect(screen.getByTestId("nav-menu")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("nav-menu-move-up"))
    expect(menu.onMove).toHaveBeenLastCalledWith(-1)

    fireEvent.contextMenu(screen.getByTestId("item"))
    fireEvent.click(screen.getByTestId("nav-menu-move-down"))
    expect(menu.onMove).toHaveBeenLastCalledWith(1)

    fireEvent.contextMenu(screen.getByTestId("item"))
    fireEvent.click(screen.getByTestId("nav-menu-unpin"))
    expect(menu.onMoveToMore).toHaveBeenCalled()

    fireEvent.contextMenu(screen.getByTestId("item"))
    fireEvent.click(screen.getByTestId("nav-menu-hide"))
    expect(menu.onHide).toHaveBeenCalled()

    fireEvent.contextMenu(screen.getByTestId("item"))
    fireEvent.click(screen.getByTestId("nav-menu-customize"))
    expect(menu.onCustomize).toHaveBeenCalled()
  })

  it("leaves Move to More out for a workspace mode, and disables the ends", () => {
    const menu = actions({ canMoveUp: false, canMoveDown: false })
    openMenu(menu)
    expect(screen.queryByTestId("nav-menu-unpin")).toBeNull()
    expect(screen.getByTestId("nav-menu-move-up")).toHaveAttribute("data-disabled")
    expect(screen.getByTestId("nav-menu-move-down")).toHaveAttribute("data-disabled")
    fireEvent.click(screen.getByTestId("nav-menu-move-up"))
    expect(menu.onMove).not.toHaveBeenCalled()
  })

  it("makes its trigger the drag handle, dimmed while it is dragged", () => {
    const binding = drag({ dragging: true, style: { opacity: 0.5 } })
    render(
      <NavItemContextMenu drag={binding} menuTestId="nav-menu" {...actions()}>
        <button type="button" data-testid="item" />
      </NavItemContextMenu>
    )
    const handle = screen.getByTestId("item").parentElement!
    expect(binding.setNodeRef).toHaveBeenCalledWith(handle)
    expect(handle).toHaveAttribute("aria-roledescription", "sortable")
    expect(handle).toHaveClass("opacity-50")
  })
})

describe("NavItemMenuItems", () => {
  it("renders the same items through another kit", () => {
    const menu = actions({ onMoveToMore: jest.fn() })
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <NavItemMenuItems kit={DROPDOWN_MENU_KIT} testIdPrefix="dd" {...menu} />
        </DropdownMenuContent>
      </DropdownMenu>
    )
    for (const action of ["move-up", "move-down", "unpin", "hide", "customize"]) {
      expect(screen.getByTestId(`dd-${action}`)).toHaveAttribute("role", "menuitem")
    }
    fireEvent.click(screen.getByTestId("dd-unpin"))
    expect(menu.onMoveToMore).toHaveBeenCalled()
  })
})
