/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import {
  CONTEXT_MENU_KIT,
  DROPDOWN_MENU_KIT,
  MENUBAR_MENU_KIT,
  MenuShortcut,
  type MenuKit,
} from "./menu-kit"

test("every kit supplies the full primitive set", () => {
  const parts: (keyof MenuKit)[] = [
    "Item",
    "Label",
    "Separator",
    "Sub",
    "SubTrigger",
    "SubContent",
    "Shortcut",
  ]
  for (const kit of [DROPDOWN_MENU_KIT, CONTEXT_MENU_KIT, MENUBAR_MENU_KIT]) {
    for (const part of parts) expect(kit[part]).toBeTruthy()
  }
})

test("the shortcut hint is decorative — the item's own name carries the action", () => {
  render(<MenuShortcut>F2</MenuShortcut>)
  expect(screen.getByText("F2")).toHaveAttribute("aria-hidden")
})
