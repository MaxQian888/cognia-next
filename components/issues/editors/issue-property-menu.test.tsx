/** @jest-environment jsdom */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

import userEvent from "@testing-library/user-event"
import { render, renderHook, screen } from "@testing-library/react"
import type { IssueMenuSection } from "@/lib/issues/menu-model"
import { IssuePropertyMenu } from "./issue-property-menu"
import { useMenuEntryPresentation } from "./menu-entry-presentation"

/** See `menu-entry-presentation.test.tsx`: a hook, by reference, not a callback. */
const useFixture = () => useMenuEntryPresentation({ labels: [], projects: [], assigneeOptions: [] })

function presentation() {
  return renderHook(useFixture).result.current
}

const statusSection: IssueMenuSection = {
  id: "status",
  entries: [
    { id: "todo", action: { kind: "status", to: "todo" }, disabled: false, checked: true },
    { id: "done", action: { kind: "status", to: "done" }, disabled: false, checked: false },
    {
      id: "in_progress",
      action: { kind: "status", to: "in_progress" },
      disabled: true,
      checked: false,
    },
  ],
}

const labelSection: IssueMenuSection = {
  id: "labels",
  entries: [
    { id: "l1", action: { kind: "addLabel", labelId: "l1" }, disabled: false, checked: false },
    { id: "l2", action: { kind: "addLabel", labelId: "l2" }, disabled: false, checked: false },
  ],
}

function renderMenu(over: Partial<React.ComponentProps<typeof IssuePropertyMenu>> = {}) {
  const props: React.ComponentProps<typeof IssuePropertyMenu> = {
    section: statusSection,
    presentation: presentation(),
    onAction: jest.fn(),
    testId: "prop",
    children: <span>Todo</span>,
    ...over,
  }
  return { props, ...render(<IssuePropertyMenu {...props} />) }
}

describe("IssuePropertyMenu", () => {
  it("shows the current value on the closed trigger", () => {
    renderMenu()
    expect(screen.getByTestId("prop")).toHaveTextContent("Todo")
  })

  it("opens on click and lists every entry", async () => {
    const user = userEvent.setup()
    renderMenu()
    await user.click(screen.getByTestId("prop"))
    expect(await screen.findByTestId("prop-todo")).toBeInTheDocument()
    expect(screen.getByTestId("prop-done")).toBeInTheDocument()
  })

  it("emits the entry's action", async () => {
    const user = userEvent.setup()
    const props = renderMenu().props
    await user.click(screen.getByTestId("prop"))
    await user.click(await screen.findByTestId("prop-done"))
    expect(props.onAction).toHaveBeenCalledWith({ kind: "status", to: "done" })
  })

  it("disables a refused entry rather than hiding it", async () => {
    const user = userEvent.setup()
    renderMenu()
    await user.click(screen.getByTestId("prop"))
    expect(await screen.findByTestId("prop-in_progress")).toHaveAttribute("aria-disabled", "true")
  })

  it("renders no trigger at all when every entry is refused", () => {
    renderMenu({ disabled: true })
    expect(screen.queryByTestId("prop")).not.toBeInTheDocument()
    expect(screen.getByTestId("prop-static")).toHaveTextContent("Todo")
  })

  it("closes after a single-select pick", async () => {
    const user = userEvent.setup()
    renderMenu()
    await user.click(screen.getByTestId("prop"))
    await user.click(await screen.findByTestId("prop-done"))
    expect(screen.queryByTestId("prop-todo")).not.toBeInTheDocument()
  })

  it("stays open for labels, so applying three is three clicks", async () => {
    const user = userEvent.setup()
    const props = renderMenu({ section: labelSection, children: <span>Labels</span> }).props
    await user.click(screen.getByTestId("prop"))
    await user.click(await screen.findByTestId("prop-l1"))
    await user.click(await screen.findByTestId("prop-l2"))
    expect(props.onAction).toHaveBeenCalledTimes(2)
  })
})
