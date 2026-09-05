/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

import { PairShell } from "./pair-shell"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("./pair-scene", () => ({
  PairScene: ({ state, client }: { state: string; client: string }) => (
    <svg data-testid="pair-scene" data-state={state} data-client={client} />
  ),
}))

function renderShell(props: Partial<React.ComponentProps<typeof PairShell>> = {}) {
  return render(
    <PairShell client="web" sceneState="armed" step="pair" bodyKey="pair" {...props}>
      <p>body</p>
    </PairShell>
  )
}

it("owns the viewport with an opaque surface", () => {
  // The wallpaper layer is a fixed `body::before` behind everything, and
  // `/pair` renders with no app chrome — so this element is the only thing
  // standing between the user's photo and the body text.
  renderShell()
  const shell = screen.getByTestId("pair-shell")
  expect(shell).toHaveClass("bg-background")
  expect(shell).toHaveClass("h-[100dvh]")
  expect(shell).toHaveClass("overflow-hidden")
})

it("gives the panel one title and the body none", () => {
  renderShell()
  // One h1 on the page: the title used to be duplicated by a page header and
  // the step's own heading.
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1)
  expect(screen.getByTestId("pair-narrative-panel")).toContainElement(
    screen.getByRole("heading", { level: 1 })
  )
})

it("narrates the scene state it is drawing", () => {
  renderShell({ sceneState: "blocked" })
  expect(screen.getByTestId("pair-scene")).toHaveAttribute("data-state", "blocked")
  expect(screen.getByTestId("pair-narration")).toHaveTextContent("narration.blocked")
})

it("renders the aside and the status inside the panel, not the body", () => {
  renderShell({
    aside: <div data-testid="aside-slot">how to mint one</div>,
    status: <div data-testid="status-slot">reachable</div>,
  })
  const panel = screen.getByTestId("pair-narrative-panel")
  expect(panel).toContainElement(screen.getByTestId("aside-slot"))
  expect(panel).toContainElement(screen.getByTestId("status-slot"))
  expect(screen.getByTestId("pair-step-body")).not.toContainElement(
    screen.getByTestId("aside-slot")
  )
})

it("omits the aside and status slots when the caller has nothing for them", () => {
  renderShell({ client: "mobile" })
  expect(screen.getByTestId("pair-scene")).toHaveAttribute("data-client", "mobile")
  expect(screen.queryByTestId("aside-slot")).not.toBeInTheDocument()
})

it("puts step-level context above the step body", () => {
  renderShell({ notice: <div data-testid="notice-slot">recovering</div> })
  expect(screen.getByTestId("pair-step-body")).toContainElement(screen.getByTestId("notice-slot"))
})

it("shows the step row the caller asked for", () => {
  renderShell({ steps: ["pair", "paired"] })
  expect(screen.getByTestId("pair-stepper").querySelectorAll("li")).toHaveLength(2)
})
