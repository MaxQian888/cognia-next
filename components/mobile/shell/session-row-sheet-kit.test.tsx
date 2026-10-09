/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { SHEET_MENU_KIT, SessionRowSheetMenu, SheetHeading } from "./session-row-sheet-kit"

const { Item, Label, Separator, Sub, SubTrigger, SubContent, Shortcut } = SHEET_MENU_KIT

function renderMenu() {
  const onPicked = jest.fn()
  const onOpen = jest.fn()
  const onFile = jest.fn()
  render(
    <SessionRowSheetMenu label="Standup" onPicked={onPicked}>
      <Label>Read-only</Label>
      <Item onSelect={onOpen} data-testid="open">
        Open
        <Shortcut>F2</Shortcut>
      </Item>
      <Separator />
      <Sub>
        <SubTrigger data-testid="to-folders">Move to folder</SubTrigger>
        <SubContent>
          <Item onSelect={onFile} aria-current="true" data-testid="folder-a">
            A
          </Item>
        </SubContent>
      </Sub>
      <Item disabled className="text-destructive" data-testid="delete">
        Delete
      </Item>
    </SessionRowSheetMenu>
  )
  return { onPicked, onOpen, onFile }
}

test("draws the main page as touch rows under the conversation's name", () => {
  renderMenu()
  expect(screen.getByRole("group", { name: "Standup" })).toBeInTheDocument()
  expect(screen.getByRole("note")).toHaveTextContent("Read-only")
  expect(screen.getByRole("separator")).toBeInTheDocument()
  expect(screen.getByTestId("open")).toHaveClass("min-h-12")
  // No key hints on a phone.
  expect(screen.queryByText("F2")).toBeNull()
  // A submenu's items wait for their page.
  expect(screen.queryByTestId("folder-a")).toBeNull()
  expect(screen.getByTestId("delete")).toBeDisabled()
  expect(screen.getByTestId("delete")).toHaveClass("text-destructive")
})

test("closes the sheet first, then runs the item", () => {
  const { onPicked, onOpen } = renderMenu()
  fireEvent.click(screen.getByTestId("open"))
  expect(onPicked).toHaveBeenCalledTimes(1)
  expect(onOpen).toHaveBeenCalledTimes(1)
  expect(onPicked.mock.invocationCallOrder[0]).toBeLessThan(onOpen.mock.invocationCallOrder[0]!)
})

test("turns a submenu into a second page, and back", () => {
  const { onPicked, onFile } = renderMenu()
  fireEvent.click(screen.getByTestId("to-folders"))
  // Opening a page is navigation, not a choice.
  expect(onPicked).not.toHaveBeenCalled()
  expect(screen.queryByTestId("open")).toBeNull()
  expect(screen.queryByRole("note")).toBeNull()
  expect(screen.getByTestId("folder-a")).toHaveAttribute("aria-current", "true")
  fireEvent.click(screen.getByTestId("session-row-sheet-back"))
  expect(screen.getByTestId("open")).toBeInTheDocument()
  fireEvent.click(screen.getByTestId("to-folders"))
  fireEvent.click(screen.getByTestId("folder-a"))
  expect(onFile).toHaveBeenCalledTimes(1)
  expect(onPicked).toHaveBeenCalledTimes(1)
})

test("refuses to render outside the sheet menu", () => {
  const spy = jest.spyOn(console, "error").mockImplementation(() => {})
  expect(() => render(<Item>Loose</Item>)).toThrow(/SessionRowSheetMenu/)
  spy.mockRestore()
})

test("draws a plain heading only on the page it belongs to", () => {
  render(
    <SessionRowSheetMenu label="Standup" onPicked={jest.fn()}>
      <SheetHeading>Main heading</SheetHeading>
      <Sub>
        <SubTrigger data-testid="to-teams">Assign</SubTrigger>
        <SubContent>
          <SheetHeading>Teams</SheetHeading>
        </SubContent>
      </Sub>
    </SessionRowSheetMenu>
  )
  // A heading, not the warning note `Label` draws.
  expect(screen.getByText("Main heading")).not.toHaveAttribute("role", "note")
  expect(screen.queryByText("Teams")).toBeNull()
  fireEvent.click(screen.getByTestId("to-teams"))
  expect(screen.getByText("Teams")).toBeInTheDocument()
  expect(screen.queryByText("Main heading")).toBeNull()
})
