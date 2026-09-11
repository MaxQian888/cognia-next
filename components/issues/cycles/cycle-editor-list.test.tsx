/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const mockCreate = jest.fn(async (..._a: unknown[]) => ({}))
const mockUpdate = jest.fn(async (..._a: unknown[]) => undefined)
const mockDelete = jest.fn(async (..._a: unknown[]) => undefined)
jest.mock("@/lib/db/issue-cycles", () => ({
  createIssueCycle: (...a: unknown[]) => mockCreate(...a),
  updateIssueCycle: (...a: unknown[]) => mockUpdate(...a),
  deleteIssueCycle: (...a: unknown[]) => mockDelete(...a),
}))
const mockToastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => mockToastError(...a) } }))

import { act, fireEvent, render, screen } from "@testing-library/react"
import type { IssueCycle } from "@/types/issues"
import { CycleEditorList } from "./cycle-editor-list"

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

function renderList(props: Partial<React.ComponentProps<typeof CycleEditorList>> = {}) {
  return render(
    <CycleEditorList
      projectId="w1"
      cycles={[cycle]}
      projects={[]}
      progress={new Map([["c1", { total: 2, done: 1, points: 0, pointsDone: 0 }]])}
      {...props}
    />
  )
}

describe("CycleEditorList", () => {
  beforeEach(() => {
    mockCreate.mockClear()
    mockUpdate.mockClear()
    mockDelete.mockClear()
    mockToastError.mockClear()
  })

  it("links each row to the board filtered by that cycle only when asked", () => {
    renderList()
    expect(screen.queryByTestId("manage-cycles-view-c1")).not.toBeInTheDocument()
    renderList({ linkToBoard: true })
    expect(screen.getByTestId("manage-cycles-view-c1")).toHaveAttribute("href", "/issues?cycle=c1")
  })

  it("lets the caller bound the list height instead of hard-coding the dialog's", () => {
    const { container } = renderList({ listClassName: "max-h-10" })
    expect(container.querySelector("ul")?.className).toContain("max-h-10")
    expect(container.querySelector("ul")?.className).not.toContain("50vh")
  })

  it("creates into the workspace and clears the form", async () => {
    renderList({ cycles: [] })
    expect(screen.getByTestId("manage-cycles-empty")).toBeInTheDocument()
    fireEvent.change(screen.getByTestId("manage-cycles-name"), { target: { value: "Sprint 2" } })
    await act(async () => {
      fireEvent.click(screen.getByTestId("manage-cycles-create"))
    })
    expect(mockCreate).toHaveBeenCalledWith({ projectId: "w1", kind: "cycle", name: "Sprint 2" })
    expect(screen.getByTestId("manage-cycles-name")).toHaveValue("")
  })

  it("surfaces a failed write as a toast rather than swallowing it", async () => {
    mockUpdate.mockRejectedValueOnce(new Error("offline"))
    renderList()
    await act(async () => {
      fireEvent.change(screen.getByTestId("manage-cycles-status-c1"), {
        target: { value: "completed" },
      })
    })
    expect(mockUpdate).toHaveBeenCalledWith("c1", { status: "completed" })
    expect(mockToastError).toHaveBeenCalledWith("offline")
  })
})
