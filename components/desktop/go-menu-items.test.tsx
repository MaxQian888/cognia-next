/**
 * @jest-environment jsdom
 */

import type { ReactNode } from "react"
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

import type { MenuKit } from "@/components/shared/menu-kit"
import { GO_MENU_IDS, GO_MENU_SECTIONS } from "@/lib/desktop/go-menu"

import { GoMenuItems } from "./go-menu-items"

// A plain-DOM kit: the component only decides what is offered and in which
// order, so the Radix primitives are not what is under test here.
const TEST_KIT: Pick<MenuKit, "Item" | "Label" | "Separator"> = {
  Item: ({ children, onSelect, "data-testid": testId }) => (
    <div role="menuitem" data-testid={testId} onClick={() => onSelect?.(new Event("select"))}>
      {children}
    </div>
  ),
  Label: ({ children }: { children?: ReactNode }) => <div data-testid="kit-label">{children}</div>,
  Separator: () => <hr data-testid="kit-separator" />,
}

function renderItems(props: Partial<React.ComponentProps<typeof GoMenuItems>> = {}) {
  const selected: string[] = []
  const handlerFor = jest.fn((id: string) => () => {
    selected.push(id)
  })
  render(<GoMenuItems kit={TEST_KIT} surface="menubar" handlerFor={handlerFor} {...props} />)
  return { selected, handlerFor }
}

describe("GoMenuItems", () => {
  it("renders every Go-menu destination in table order", () => {
    renderItems()
    const ids = screen
      .getAllByRole("menuitem")
      .map((el) => el.getAttribute("data-testid")?.replace("go-menu-menubar-", ""))
    expect(ids).toEqual([...GO_MENU_IDS])
  })

  it("puts one separator between sections and none at the edges", () => {
    const { container } = render(
      <GoMenuItems kit={TEST_KIT} surface="menubar" handlerFor={() => () => undefined} />
    )
    expect(screen.getAllByTestId("kit-separator")).toHaveLength(GO_MENU_SECTIONS.length - 1)
    expect(container.firstElementChild?.tagName).toBe("DIV")
    expect(container.lastElementChild?.tagName).toBe("DIV")
    // Each separator sits right after a section's last item.
    for (const section of GO_MENU_SECTIONS.slice(0, -1)) {
      const last = screen.getByTestId(`go-menu-menubar-${section[section.length - 1].id}`)
      expect(last.nextElementSibling?.getAttribute("data-testid")).toBe("kit-separator")
    }
  })

  it("labels each item with the rail's string and draws its icon", () => {
    renderItems()
    const twin = screen.getByTestId("go-menu-menubar-go-twin")
    expect(twin).toHaveTextContent("desktop.guildRail.twin")
    expect(twin.querySelector("svg")).not.toBeNull()
    expect(screen.getByTestId("go-menu-menubar-go-dms")).toHaveTextContent(
      "desktop.guildRail.directMessages"
    )
  })

  it("shows no keyboard-shortcut hint on any item", () => {
    renderItems()
    for (const item of screen.getAllByRole("menuitem")) {
      expect(item.textContent).not.toMatch(/shortcut|⌘|Ctrl/)
    }
  })

  it("dispatches through the handler for the selected id", () => {
    const { selected, handlerFor } = renderItems()
    fireEvent.click(screen.getByTestId("go-menu-menubar-go-issues"))
    fireEvent.click(screen.getByTestId("go-menu-menubar-go-canvas"))
    expect(selected).toEqual(["go-issues", "go-canvas"])
    expect(handlerFor).toHaveBeenCalledTimes(GO_MENU_IDS.length)
  })

  it("leads with the Go label only when asked, and namespaces test ids by surface", () => {
    renderItems({ surface: "dropdown", withLabel: true })
    expect(screen.getByTestId("kit-label")).toHaveTextContent("desktop.menu.go.label")
    expect(screen.getByTestId("go-menu-dropdown-go-inbox")).toBeInTheDocument()
  })

  it("omits the label by default", () => {
    renderItems()
    expect(screen.queryByTestId("kit-label")).toBeNull()
  })
})
