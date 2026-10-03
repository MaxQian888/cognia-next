/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SessionSummaryCardMenu } from "./session-summary-card-menu"
import { useSessionSummaryCardPrefs } from "@/components/shell/use-session-summary-card-prefs"
import { revealSessionPanel } from "@/lib/artifacts/reveal"
import { DEFAULT_SUMMARY_CARD_ROWS } from "@/types/shell/session-summary-card"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/components/shell/use-session-summary-card-prefs", () => ({
  useSessionSummaryCardPrefs: jest.fn(),
}))
jest.mock("@/lib/artifacts/reveal", () => ({ revealSessionPanel: jest.fn() }))

const setRow = jest.fn(async () => {})
const reset = jest.fn(async () => {})

function prefs(isDefault = true) {
  jest.mocked(useSessionSummaryCardPrefs).mockReturnValue({
    rows: { ...DEFAULT_SUMMARY_CARD_ROWS },
    isDefault,
    setRow,
    reset,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  prefs()
})

async function openMenu(props: Partial<Parameters<typeof SessionSummaryCardMenu>[0]> = {}) {
  const user = userEvent.setup()
  const onManageSources = jest.fn()
  const onHide = jest.fn()
  render(
    <SessionSummaryCardMenu
      sessionId="s1"
      mode="popover"
      onManageSources={onManageSources}
      onHide={onHide}
      {...props}
    />
  )
  await user.click(screen.getByRole("button", { name: "menu" }))
  return { user, onManageSources, onHide }
}

it("lists every row with its current visibility", async () => {
  await openMenu()
  for (const id of ["progress", "needsYou", "changes", "artifacts", "sources"]) {
    expect(screen.getByRole("menuitem", { name: new RegExp(`rows\\.${id}`) })).toBeInTheDocument()
  }
  expect(screen.getByRole("menuitem", { name: /rows\.changes.*visibility\.always/ })).toBeVisible()
})

it("changes one row's visibility", async () => {
  const { user } = await openMenu()
  // Radix opens a submenu from the keyboard; jsdom has no hover intent.
  screen.getByRole("menuitem", { name: /rows\.changes/ }).focus()
  await user.keyboard("{ArrowRight}")
  await user.click(await screen.findByRole("menuitemradio", { name: "visibility.never" }))
  expect(setRow).toHaveBeenCalledWith("changes", "never")
})

it("disables the reset while every row is at its default", async () => {
  await openMenu()
  expect(screen.getByRole("menuitem", { name: "resetRows" })).toHaveAttribute("data-disabled")
})

it("resets rows that differ from the defaults", async () => {
  prefs(false)
  const { user } = await openMenu()
  await user.click(screen.getByRole("menuitem", { name: "resetRows" }))
  expect(reset).toHaveBeenCalled()
})

it("opens the task overview and the capabilities settings", async () => {
  const { user, onManageSources } = await openMenu()
  await user.click(screen.getByRole("menuitem", { name: "openOverview" }))
  expect(revealSessionPanel).toHaveBeenCalledWith("s1", "metadata")
  await user.click(screen.getByRole("button", { name: "menu" }))
  await user.click(screen.getByRole("menuitem", { name: "addSource" }))
  expect(onManageSources).toHaveBeenCalled()
})

it("offers hiding only for a floating card", async () => {
  const { user, onHide } = await openMenu({ mode: "float" })
  await user.click(screen.getByRole("menuitem", { name: "unpinCard" }))
  expect(onHide).toHaveBeenCalled()
})

it("has no hide entry in a popover", async () => {
  await openMenu({ mode: "popover" })
  expect(screen.queryByRole("menuitem", { name: "unpinCard" })).not.toBeInTheDocument()
})
