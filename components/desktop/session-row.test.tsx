/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ChatSession } from "@/lib/claude/types"

const logInfo = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/logger", () => ({
  loggers: {
    ui: {
      info: (...args: unknown[]) => logInfo(...args),
      warn: jest.fn(),
      error: jest.fn(),
    },
  },
}))

import { SessionRow } from "./session-row"

const baseSession: ChatSession = {
  id: "s-1",
  title: "Hello",
  kind: "direct",
  createdAt: 0,
  updatedAt: 0,
}

beforeEach(() => {
  logInfo.mockReset()
})

function setup(overrides: Partial<Parameters<typeof SessionRow>[0]> = {}) {
  const onSelect = jest.fn()
  const onDelete = jest.fn()
  const onRename = jest.fn()
  const utils = render(
    <ul>
      <SessionRow
        session={baseSession}
        active={false}
        onSelect={onSelect}
        onDelete={onDelete}
        onRename={onRename}
        {...overrides}
      />
    </ul>
  )
  return { ...utils, onSelect, onDelete, onRename }
}

test("renders title and clicking the row selects the session", async () => {
  const user = userEvent.setup()
  const { onSelect } = setup()
  await user.click(screen.getByRole("button", { name: /Hello/ }))
  expect(onSelect).toHaveBeenCalledWith("s-1")
  expect(logInfo).toHaveBeenCalledWith(
    "session select",
    expect.objectContaining({ sessionId: "s-1" })
  )
})

test("renders the untitled fallback when title is blank", () => {
  setup({ session: { ...baseSession, title: "" } })
  expect(screen.getByText("untitled")).toBeInTheDocument()
})

test("shows unread badge with cap at 99+", () => {
  const { rerender } = setup({ unread: 5 })
  expect(screen.getByText("5")).toBeInTheDocument()
  rerender(
    <ul>
      <SessionRow
        session={baseSession}
        active={false}
        unread={250}
        onSelect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    </ul>
  )
  expect(screen.getByText("99+")).toBeInTheDocument()
})

test("double click enters rename mode and Enter commits a non-empty change", async () => {
  const user = userEvent.setup()
  const { onRename } = setup()
  const button = screen.getByRole("button", { name: /Hello/ })
  await user.dblClick(button)
  const input = screen.getByDisplayValue("Hello") as HTMLInputElement
  await user.clear(input)
  await user.type(input, "World{Enter}")
  expect(onRename).toHaveBeenCalledWith("s-1", "World")
  expect(logInfo).toHaveBeenCalledWith(
    "session rename commit",
    expect.objectContaining({ sessionId: "s-1", length: 5 })
  )
})

test("Escape cancels rename without calling onRename", async () => {
  const user = userEvent.setup()
  const { onRename } = setup()
  await user.dblClick(screen.getByRole("button", { name: /Hello/ }))
  const input = screen.getByDisplayValue("Hello") as HTMLInputElement
  await user.clear(input)
  await user.type(input, "Other{Escape}")
  expect(onRename).not.toHaveBeenCalled()
  expect(logInfo).toHaveBeenCalledWith(
    "session rename cancel",
    expect.objectContaining({ sessionId: "s-1" })
  )
})

test("commits no rename when title unchanged", async () => {
  const user = userEvent.setup()
  const { onRename } = setup()
  await user.dblClick(screen.getByRole("button", { name: /Hello/ }))
  const input = screen.getByDisplayValue("Hello") as HTMLInputElement
  await user.type(input, "{Enter}")
  expect(onRename).not.toHaveBeenCalled()
})

test("renders an accent dot when accentColor is provided", () => {
  setup({ accentColor: "#ff0000" })
  // Both the icon-less accent dot and the action menu show the title button.
  expect(screen.getByRole("button", { name: /Hello/ })).toBeInTheDocument()
})

test("renders different icons by session kind", () => {
  setup({ session: { ...baseSession, kind: "team", teamId: "t-1" } })
  expect(screen.getByRole("button", { name: /Hello/ })).toBeInTheDocument()
})
