/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

import userEvent from "@testing-library/user-event"
import { render, screen, waitFor } from "@testing-library/react"
import { statusCategoryOf } from "@/types/issues"
import type { IssueProject } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import { IssueContextMenu } from "./issue-context-menu"

function item(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  const kind = over.kind ?? "local"
  return {
    unifiedId: `${kind}:i1`,
    kind,
    sourceId: "i1",
    identifier: "MERC-1",
    title: "Ship it",
    status: "todo",
    statusCategory: statusCategoryOf("todo"),
    priority: "none",
    labelIds: [],
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    origin: { deepLinkHref: "/issues" },
    capabilities: kind === "local" ? FULL_ISSUE_CAPABILITIES : READ_ONLY_ISSUE_CAPABILITIES,
    ...over,
  }
}

const label: LabelRow = {
  id: "l1",
  scope: "issue",
  name: "bug",
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
}
const project: IssueProject = {
  id: "p1",
  projectId: "w1",
  key: "MERC",
  name: "Mercury",
  status: "in_progress",
  priority: "medium",
  resources: [],
  createdAt: 0,
  updatedAt: 0,
}

function renderMenu(over: Partial<React.ComponentProps<typeof IssueContextMenu>> = {}) {
  const props: React.ComponentProps<typeof IssueContextMenu> = {
    item: item(),
    labels: [label],
    projects: [project],
    assigneeOptions: [
      { key: "agent:a1", actor: { kind: "agent", id: "a1", label: "Scout" }, group: "agent" },
    ],
    onAction: jest.fn(),
    children: <div data-testid="anchor">row</div>,
    ...over,
  }
  return { props, ...render(<IssueContextMenu {...props} />) }
}

/**
 * Open the menu, then step into one submenu.
 *
 * Radix opens a submenu on pointer-enter, not on click, so this hovers the
 * trigger and waits for the panel rather than clicking it.
 */
async function openSub(user: ReturnType<typeof userEvent.setup>, testId: string) {
  await user.pointer({ keys: "[MouseRight]", target: screen.getByTestId("anchor") })
  const trigger = await screen.findByTestId(testId)
  await user.hover(trigger)
  await waitFor(() => expect(trigger).toHaveAttribute("data-state", "open"))
}

describe("IssueContextMenu", () => {
  it("renders its child untouched until right-clicked", () => {
    renderMenu()
    expect(screen.getByTestId("anchor")).toBeInTheDocument()
    expect(screen.queryByTestId("issue-context-status")).not.toBeInTheDocument()
  })

  it("opens on right-click", async () => {
    const user = userEvent.setup()
    renderMenu()
    await user.pointer({ keys: "[MouseRight]", target: screen.getByTestId("anchor") })
    expect(await screen.findByTestId("issue-context-status")).toBeInTheDocument()
  })

  it("offers open only when the caller can handle it", async () => {
    const user = userEvent.setup()
    renderMenu()
    await user.pointer({ keys: "[MouseRight]", target: screen.getByTestId("anchor") })
    expect(screen.queryByTestId("issue-context-open")).not.toBeInTheDocument()
  })

  /*
   * NOTE — Radix nested submenus do not fire their selection events under
   * jsdom (the parent content keeps the active layer, so `onSelect` never
   * runs). What each entry DOES is therefore proved in
   * `lib/issues/menu-model.test.ts`, which owns the action payloads and the
   * capability gating; this suite proves the entries render, carry the right
   * labels, and honour the disabled state the model hands down.
   */

  it("renders every section a populated issue can act on", async () => {
    const user = userEvent.setup()
    renderMenu()
    await user.pointer({ keys: "[MouseRight]", target: screen.getByTestId("anchor") })
    for (const id of ["status", "priority", "assignee", "labels", "project"]) {
      expect(await screen.findByTestId(`issue-context-${id}`)).toBeInTheDocument()
    }
  })

  it("localizes status entries rather than showing the raw enum", async () => {
    const user = userEvent.setup()
    renderMenu()
    await openSub(user, "issue-context-status")
    expect(await screen.findByTestId("issue-context-status-done")).toHaveTextContent("status.done")
  })

  it("localizes priority entries", async () => {
    const user = userEvent.setup()
    renderMenu()
    await openSub(user, "issue-context-priority")
    expect(await screen.findByTestId("issue-context-priority-urgent")).toHaveTextContent(
      "priority.urgent"
    )
  })

  it("resolves an assignee key to its cached display name", async () => {
    const user = userEvent.setup()
    renderMenu()
    await openSub(user, "issue-context-assignee")
    expect(await screen.findByTestId("issue-context-assignee-agent:a1")).toHaveTextContent("Scout")
  })

  it("resolves a label id to its name — the raw id must never reach the user", async () => {
    const user = userEvent.setup()
    renderMenu()
    await openSub(user, "issue-context-labels")
    const entry = await screen.findByTestId("issue-context-labels-l1")
    expect(entry).toHaveTextContent("bug")
    expect(entry).not.toHaveTextContent("l1")
  })

  it("resolves a container id to its name", async () => {
    const user = userEvent.setup()
    renderMenu()
    await openSub(user, "issue-context-project")
    expect(await screen.findByTestId("issue-context-project-p1")).toHaveTextContent("Mercury")
  })

  it("routes delete through a confirmation", async () => {
    const user = userEvent.setup()
    const onRequestDelete = jest.fn()
    const props = renderMenu({ onRequestDelete }).props
    await user.pointer({ keys: "[MouseRight]", target: screen.getByTestId("anchor") })
    await user.click(await screen.findByTestId("issue-context-delete"))
    expect(onRequestDelete).toHaveBeenCalled()
    expect(props.onAction).not.toHaveBeenCalled()
  })

  describe("federated rows", () => {
    it("disables the actions rather than hiding them", async () => {
      const user = userEvent.setup()
      renderMenu({ item: item({ kind: "github" }) })
      await openSub(user, "issue-context-status")
      expect(await screen.findByTestId("issue-context-status-done")).toHaveAttribute(
        "aria-disabled",
        "true"
      )
    })

    it("disables delete too", async () => {
      const user = userEvent.setup()
      renderMenu({ item: item({ kind: "github" }), onRequestDelete: jest.fn() })
      await user.pointer({ keys: "[MouseRight]", target: screen.getByTestId("anchor") })
      expect(await screen.findByTestId("issue-context-delete")).toHaveAttribute(
        "aria-disabled",
        "true"
      )
    })
  })

  it("locks the status submenu while a run holds the issue", async () => {
    const user = userEvent.setup()
    renderMenu({ running: true })
    await openSub(user, "issue-context-status")
    expect(await screen.findByTestId("issue-context-status-in_progress")).toHaveAttribute(
      "aria-disabled",
      "true"
    )
  })

  it("still allows a non-status edit while running", async () => {
    const user = userEvent.setup()
    renderMenu({ running: true })
    await openSub(user, "issue-context-priority")
    expect(await screen.findByTestId("issue-context-priority-urgent")).not.toHaveAttribute(
      "aria-disabled",
      "true"
    )
  })

  it("hides the label submenu when there are no labels", async () => {
    const user = userEvent.setup()
    renderMenu({ labels: [] })
    await user.pointer({ keys: "[MouseRight]", target: screen.getByTestId("anchor") })
    expect(screen.queryByTestId("issue-context-labels")).not.toBeInTheDocument()
  })
})
