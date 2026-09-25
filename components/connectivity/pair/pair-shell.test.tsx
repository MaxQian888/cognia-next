/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

import { PairShell } from "./pair-shell"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/components/desktop/window-controls", () => ({
  useWindowChromeMode: () => "none",
  WindowControls: () => null,
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

it("opens the step body with its heading, as every onboarding step does", () => {
  renderShell({ heading: { title: "Pair this browser", description: "Paste the invitation." } })
  // One h1 on the page, in the body: the panel beside it narrates the scene,
  // the same split `/onboarding` uses (ADR-0193).
  const h1 = screen.getByRole("heading", { level: 1, name: "Pair this browser" })
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1)
  expect(screen.getByTestId("pair-step-body")).toContainElement(h1)
  expect(screen.getByTestId("pair-narrative-panel")).not.toContainElement(h1)
  expect(screen.getByText("Paste the invitation.")).toBeInTheDocument()
})

it("narrates the flow in the panel headline", () => {
  renderShell()
  expect(screen.getByTestId("pair-narrative-headline")).toHaveTextContent("web.title")
  renderShell({ client: "mobile" })
  expect(screen.getAllByTestId("pair-narrative-headline")[1]).toHaveTextContent("title")
})

it("draws the same window bar as the first-run flow, with the wordmark in it", () => {
  renderShell()
  const bar = screen.getByTestId("pair-window-bar")
  expect(bar).toHaveTextContent("brandMark")
  expect(screen.getByTestId("pair-narrative-panel")).not.toHaveTextContent("brandMark")
})

it("enters like the first-run flow and scrolls as one page below md", () => {
  renderShell()
  expect(screen.getByTestId("pair-shell")).toHaveClass("animate-in", "fade-in")
  expect(screen.getByTestId("pair-narrative-panel")).toHaveAttribute("data-overflow", "scroll")
})

it("narrates the scene state it is drawing", () => {
  renderShell({ sceneState: "blocked" })
  expect(screen.getByTestId("pair-scene")).toHaveAttribute("data-state", "blocked")
  expect(screen.getByTestId("pair-narrative-body")).toHaveTextContent("narration.blocked")
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
