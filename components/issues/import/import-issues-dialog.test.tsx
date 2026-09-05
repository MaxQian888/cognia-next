/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const mockImport = jest.fn(async (..._a: unknown[]) => ({
  created: 2,
  skipped: 1,
  failed: 0,
  createdIds: ["a", "b"],
  errors: [],
}))
jest.mock("@/lib/issues/import/apply", () => ({
  importIssues: (...a: unknown[]) => mockImport(...a),
}))
const mockToast = { success: jest.fn(), error: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => mockToast.success(...a),
    error: (...a: unknown[]) => mockToast.error(...a),
  },
}))

import { act, fireEvent, render, screen } from "@testing-library/react"
import type { IssueProject } from "@/types/issues"
import { ImportIssuesDialog } from "./import-issues-dialog"

const projects: IssueProject[] = [
  {
    id: "p1",
    projectId: "w1",
    key: "MERC",
    name: "Mercury",
    status: "backlog",
    priority: "none",
    resources: [],
    createdAt: 1,
    updatedAt: 1,
  },
]

function renderDialog(over: Partial<React.ComponentProps<typeof ImportIssuesDialog>> = {}) {
  const props: React.ComponentProps<typeof ImportIssuesDialog> = {
    open: true,
    onOpenChange: jest.fn(),
    projectId: "w1",
    projects,
    ...over,
  }
  return { ...render(<ImportIssuesDialog {...props} />), props }
}

describe("ImportIssuesDialog", () => {
  beforeEach(() => {
    mockImport.mockClear()
    mockToast.success.mockClear()
    mockToast.error.mockClear()
  })

  it("stays disabled until something parses, then previews the rows", () => {
    renderDialog()
    expect(screen.getByTestId("import-issues-submit")).toBeDisabled()
    fireEvent.change(screen.getByTestId("import-issues-text"), {
      target: { value: "- [ ] First\n- [x] Second\n  - [ ] Child" },
    })
    expect(screen.getByTestId("import-issues-preview")).toHaveTextContent(
      'import.preview:{"count":3,"skipped":0}'
    )
    expect(screen.getByTestId("import-issues-preview")).toHaveTextContent("Child")
    expect(screen.getByTestId("import-issues-submit")).toBeEnabled()
  })

  it("shows a parse error for broken JSON instead of a preview", () => {
    renderDialog()
    fireEvent.change(screen.getByTestId("import-issues-text"), { target: { value: "{oops" } })
    expect(screen.getByTestId("import-issues-error")).toHaveTextContent("JSON")
    expect(screen.queryByTestId("import-issues-preview")).toBeNull()
    expect(screen.getByTestId("import-issues-submit")).toBeDisabled()
  })

  it("imports into the chosen container with the parsed rows and reports the counts", async () => {
    const onImported = jest.fn()
    const { props } = renderDialog({ onImported, initialProjectId: "p1" })
    fireEvent.change(screen.getByTestId("import-issues-text"), {
      target: { value: "title,status\nA,todo\nB,done" },
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId("import-issues-submit"))
    })
    expect(mockImport).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "w1",
        issueProjectId: "p1",
        format: "csv",
        rows: [
          expect.objectContaining({ title: "A", status: "todo" }),
          expect.objectContaining({ title: "B", status: "done" }),
        ],
        by: { kind: "human" },
      })
    )
    expect(mockToast.success).toHaveBeenCalledWith('import.done:{"created":2,"skipped":1}')
    expect(onImported).toHaveBeenCalled()
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  it("reads a dropped file and names it", async () => {
    renderDialog()
    const file = new File(["- [ ] From file"], "todo.md", { type: "text/markdown" })
    await act(async () => {
      fireEvent.change(screen.getByTestId("import-issues-file"), { target: { files: [file] } })
    })
    expect(await screen.findByText("todo.md")).toBeInTheDocument()
    expect(await screen.findByTestId("import-issues-preview")).toHaveTextContent("From file")
  })

  it("says so when rows failed", async () => {
    mockImport.mockResolvedValueOnce({
      created: 1,
      skipped: 0,
      failed: 1,
      createdIds: ["a"],
      errors: [{ externalId: "x", error: "boom" }],
    })
    renderDialog()
    fireEvent.change(screen.getByTestId("import-issues-text"), { target: { value: "title\nA\nB" } })
    await act(async () => {
      fireEvent.click(screen.getByTestId("import-issues-submit"))
    })
    expect(mockToast.error).toHaveBeenCalledWith(
      'import.failed:{"created":1,"failed":1,"reason":"boom"}'
    )
  })
})
