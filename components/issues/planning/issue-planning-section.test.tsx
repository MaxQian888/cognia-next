/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { statusCategoryOf } from "@/types/issues"
import type { IssueCycle, IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { IssuePlanningSection, providerKey } from "./issue-planning-section"

let seq = 0
function local(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  seq += 1
  const sourceId = over.sourceId ?? `i${seq}`
  const status: IssueStatus = over.status ?? "todo"
  return {
    unifiedId: `local:${sourceId}`,
    kind: "local",
    sourceId,
    identifier: `MERC-${seq}`,
    title: `Issue ${seq}`,
    status,
    statusCategory: statusCategoryOf(status),
    priority: "none",
    labelIds: [],
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    origin: { deepLinkHref: "/issues" },
    capabilities: FULL_ISSUE_CAPABILITIES,
    ...over,
  }
}

const cycle: IssueCycle = {
  id: "c1",
  projectId: "w1",
  kind: "cycle",
  name: "Sprint 1",
  status: "active",
  externalRefs: [],
  externalKeys: [],
  createdAt: 1,
  updatedAt: 1,
}

describe("IssuePlanningSection", () => {
  beforeEach(() => {
    seq = 0
  })

  it("emits due date, estimate, parent and blocker actions through one callback", () => {
    const onAction = jest.fn()
    const parent = local({ sourceId: "p" })
    const other = local({ sourceId: "o" })
    const item = local({ sourceId: "me", dueDate: Date.UTC(2026, 8, 6, 12), estimate: 2 })
    render(
      <IssuePlanningSection
        item={item}
        items={[parent, other, item]}
        cycles={[cycle]}
        onAction={onAction}
      />
    )

    fireEvent.change(screen.getByTestId("issue-detail-due-date"), {
      target: { value: "2026-10-01" },
    })
    expect(onAction).toHaveBeenLastCalledWith({
      kind: "dueDate",
      to: new Date(2026, 9, 1, 12).getTime(),
    })
    fireEvent.click(screen.getByTestId("issue-detail-due-date-clear"))
    expect(onAction).toHaveBeenLastCalledWith({ kind: "dueDate", to: null })

    fireEvent.change(screen.getByTestId("issue-detail-estimate"), { target: { value: "5" } })
    expect(onAction).toHaveBeenLastCalledWith({ kind: "estimate", to: 5 })
    fireEvent.change(screen.getByTestId("issue-detail-estimate"), { target: { value: "" } })
    expect(onAction).toHaveBeenLastCalledWith({ kind: "estimate", to: null })

    fireEvent.click(screen.getByTestId("issue-detail-parent-picker-trigger"))
    fireEvent.click(screen.getByTestId("issue-detail-parent-picker-option-p"))
    expect(onAction).toHaveBeenLastCalledWith({ kind: "parent", parentId: "p" })

    fireEvent.click(screen.getByTestId("issue-detail-blocker-picker-trigger"))
    fireEvent.click(screen.getByTestId("issue-detail-blocker-picker-option-o"))
    expect(onAction).toHaveBeenLastCalledWith({ kind: "addBlocker", blockerId: "o" })
  })

  it("lists parent, sub-issues, blockers and the derived blocks side", () => {
    const onAction = jest.fn()
    const parent = local({ sourceId: "p" })
    const item = local({ sourceId: "me", parentId: "p", blockedBy: ["b"] })
    const child = local({ sourceId: "c", parentId: "me" })
    const blocker = local({ sourceId: "b" })
    const blocked = local({ sourceId: "x", blockedBy: ["me"] })
    render(
      <IssuePlanningSection
        item={item}
        items={[parent, item, child, blocker, blocked]}
        cycles={[]}
        onAction={onAction}
      />
    )
    expect(screen.getByTestId("issue-detail-parent-p")).toHaveTextContent(parent.identifier)
    expect(screen.getByTestId("issue-detail-subissue-c")).toBeInTheDocument()
    expect(screen.getByTestId("issue-detail-blocker-b")).toBeInTheDocument()
    expect(screen.getByTestId("issue-detail-blocks-x")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("issue-detail-parent-p-remove"))
    expect(onAction).toHaveBeenLastCalledWith({ kind: "parent", parentId: null })
    fireEvent.click(screen.getByTestId("issue-detail-blocker-b-remove"))
    expect(onAction).toHaveBeenLastCalledWith({ kind: "removeBlocker", blockerId: "b" })
  })

  it("disables parent candidates that would form a loop", () => {
    const item = local({ sourceId: "a" })
    const child = local({ sourceId: "b", parentId: "a" })
    render(
      <IssuePlanningSection item={item} items={[item, child]} cycles={[]} onAction={jest.fn()} />
    )
    fireEvent.click(screen.getByTestId("issue-detail-parent-picker-trigger"))
    expect(screen.getByTestId("issue-detail-parent-picker-option-b")).toHaveAttribute(
      "aria-disabled",
      "true"
    )
  })

  it("renders read-only for a federated row", () => {
    const item: UnifiedIssueItem = {
      ...local({ sourceId: "gh", dueDate: 1 }),
      unifiedId: "github:gh",
      kind: "github",
      capabilities: READ_ONLY_ISSUE_CAPABILITIES,
    }
    render(
      <IssuePlanningSection item={item} items={[item]} cycles={[cycle]} onAction={jest.fn()} />
    )
    expect(screen.queryByTestId("issue-detail-due-date")).toBeNull()
    expect(screen.queryByTestId("issue-detail-parent-picker-trigger")).toBeNull()
    expect(screen.getByTestId("issue-detail-cycle-static")).toHaveTextContent("planning.noCycle")
  })

  it("lists external refs and unlinks through the vocabulary", () => {
    const onAction = jest.fn()
    const item = local({
      sourceId: "me",
      externalRefs: [
        { provider: "lark-task", externalId: "guid1", url: "https://x/1", label: "Lark task" },
        { provider: "acme-plugin", externalId: "42" },
      ],
    })
    render(<IssuePlanningSection item={item} items={[item]} cycles={[]} onAction={onAction} />)
    const list = screen.getByTestId("issue-detail-external-refs")
    expect(list).toHaveTextContent("planning.provider.lark-task")
    expect(list).toHaveTextContent("planning.provider.other")
    fireEvent.click(screen.getByTestId("issue-detail-unlink-lark-task-guid1"))
    expect(onAction).toHaveBeenLastCalledWith({
      kind: "unlinkExternal",
      ref: { provider: "lark-task", externalId: "guid1" },
    })
  })

  it("offers to create a sub-issue when the caller can open the dialog", () => {
    const onCreateSubIssue = jest.fn()
    const item = local({ sourceId: "me" })
    render(
      <IssuePlanningSection
        item={item}
        items={[item]}
        cycles={[]}
        onAction={jest.fn()}
        onCreateSubIssue={onCreateSubIssue}
      />
    )
    fireEvent.click(screen.getByTestId("issue-detail-add-subissue"))
    expect(onCreateSubIssue).toHaveBeenCalled()
  })
})

describe("providerKey", () => {
  it("maps built-ins to their key and everything else to other", () => {
    expect(providerKey("github")).toBe("github")
    expect(providerKey("import:csv")).toBe("import_csv")
    expect(providerKey("my-plugin")).toBe("other")
  })
})
