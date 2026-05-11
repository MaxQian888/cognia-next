/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (values) return `${key}(${JSON.stringify(values)})`
    return key
  },
}))

const exportTasks = jest.fn(async () => ({ tasks: [{ id: "t1" }] }))
const importTasks = jest.fn(async () => ({ imported: 2, skipped: 0, errors: [] }))
jest.mock("@/hooks/scheduler", () => ({
  useScheduler: () => ({ exportTasks, importTasks }),
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

const logInfo = jest.fn()
const logError = jest.fn()
jest.mock("@/lib/logger", () => ({
  loggers: {
    scheduler: {
      info: (...a: unknown[]) => logInfo(...a),
      error: (...a: unknown[]) => logError(...a),
    },
  },
}))

// Stub Dialog + RadioGroup + Label to render inline.
jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>,
}))

jest.mock("@/components/ui/radio-group", () => ({
  RadioGroup: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (v: string) => void
    children: React.ReactNode
  }) => (
    <div data-testid="radio-group" data-value={value}>
      {children}
      <button
        type="button"
        data-testid="radio-set-selected"
        onClick={() => onValueChange("selected")}
      />
      <button
        type="button"
        data-testid="radio-set-replace"
        onClick={() => onValueChange("replace")}
      />
      <button type="button" data-testid="radio-set-merge" onClick={() => onValueChange("merge")} />
      <button type="button" data-testid="radio-set-all" onClick={() => onValueChange("all")} />
    </div>
  ),
  RadioGroupItem: () => <input type="radio" />,
}))

jest.mock("@/components/ui/label", () => ({
  Label: ({ children }: { children: React.ReactNode }) => <label>{children}</label>,
}))

import { ExportTasksDialog, ImportTasksDialog } from "./import-export-dialog"

beforeEach(() => {
  exportTasks.mockClear()
  importTasks.mockClear()
  toastSuccess.mockClear()
  toastError.mockClear()
})

describe("ExportTasksDialog", () => {
  beforeEach(() => {
    // jsdom doesn't ship URL.createObjectURL.
    Object.assign(URL, {
      createObjectURL: jest.fn(() => "blob:fake"),
      revokeObjectURL: jest.fn(),
    })
  })

  it("returns null when closed", () => {
    const { container } = render(<ExportTasksDialog open={false} onOpenChange={jest.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it("exports all tasks and shows a success toast", async () => {
    const onOpenChange = jest.fn()
    render(<ExportTasksDialog open={true} onOpenChange={onOpenChange} />)
    await act(async () => {
      fireEvent.click(
        screen
          .getAllByRole("button")
          .filter((b) => b.textContent?.includes("importExport.exportTitle"))[0]!
      )
      await Promise.resolve()
    })
    expect(exportTasks).toHaveBeenCalled()
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("exports the selected subset when scope is 'selected'", async () => {
    render(
      <ExportTasksDialog
        open={true}
        onOpenChange={jest.fn()}
        selectedTaskIds={new Set(["t1", "t2"])}
      />
    )
    fireEvent.click(screen.getByTestId("radio-set-selected"))
    await act(async () => {
      fireEvent.click(
        screen
          .getAllByRole("button")
          .filter((b) => b.textContent?.includes("importExport.exportTitle"))[0]!
      )
      await Promise.resolve()
    })
    await waitFor(() => expect(exportTasks).toHaveBeenCalled())
    expect((exportTasks.mock.calls[0] as unknown[])[0]).toEqual(["t1", "t2"])
  })

  it("shows error toast when export fails", async () => {
    exportTasks.mockRejectedValueOnce(new Error("boom"))
    render(<ExportTasksDialog open={true} onOpenChange={jest.fn()} />)
    await act(async () => {
      fireEvent.click(
        screen
          .getAllByRole("button")
          .filter((b) => b.textContent?.includes("importExport.exportTitle"))[0]!
      )
      await Promise.resolve()
    })
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })

  it("dispatches cancel via the Cancel button", () => {
    const onOpenChange = jest.fn()
    render(<ExportTasksDialog open={true} onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByText("cancel"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe("ImportTasksDialog", () => {
  it("returns null when closed", () => {
    const { container } = render(<ImportTasksDialog open={false} onOpenChange={jest.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it("parses an uploaded JSON file and enables the Import button", async () => {
    render(<ImportTasksDialog open={true} onOpenChange={jest.fn()} />)
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['{"tasks":[{"id":"a"},{"id":"b"}]}'], "data.json", {
      type: "application/json",
    })
    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [file] })
      fireEvent.change(fileInput)
      // FileReader is async — wait one tick.
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(screen.getByText(/importExport\.preview/)).toBeInTheDocument()
  })

  it("imports parsed tasks in merge mode and shows a success toast", async () => {
    render(<ImportTasksDialog open={true} onOpenChange={jest.fn()} />)
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(["[{}, {}]"], "data.json")
    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [file] })
      fireEvent.change(fileInput)
      await new Promise((r) => setTimeout(r, 10))
    })
    const importBtn = screen
      .getAllByRole("button")
      .find((b) => b.textContent?.includes("importExport.importTitle"))!
    await act(async () => {
      fireEvent.click(importBtn)
      await Promise.resolve()
    })
    await waitFor(() => expect(importTasks).toHaveBeenCalledWith(expect.any(String), "merge"))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
  })

  it("renders the replace-mode warning when switching modes", () => {
    render(<ImportTasksDialog open={true} onOpenChange={jest.fn()} />)
    fireEvent.click(screen.getByTestId("radio-set-replace"))
    expect(screen.getByText(/importExport\.replaceWarning/)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("radio-set-merge"))
    expect(screen.queryByText(/importExport\.replaceWarning/)).toBeNull()
  })

  it("dispatches error toast on import failure", async () => {
    importTasks.mockRejectedValueOnce(new Error("import boom"))
    render(<ImportTasksDialog open={true} onOpenChange={jest.fn()} />)
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(["[{}]"], "x.json")
    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [file] })
      fireEvent.change(fileInput)
      await new Promise((r) => setTimeout(r, 10))
    })
    const importBtn = screen
      .getAllByRole("button")
      .find((b) => b.textContent?.includes("importExport.importTitle"))!
    await act(async () => {
      fireEvent.click(importBtn)
      await Promise.resolve()
    })
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })

  it("invokes onOpenChange(false) via Cancel", () => {
    const onOpenChange = jest.fn()
    render(<ImportTasksDialog open={true} onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByText("cancel"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("handles malformed JSON gracefully (previewCount = 0)", async () => {
    render(<ImportTasksDialog open={true} onOpenChange={jest.fn()} />)
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(["not json"], "x.json")
    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [file] })
      fireEvent.change(fileInput)
      await new Promise((r) => setTimeout(r, 10))
    })
    // No preview badge should render.
    expect(screen.queryByText(/importExport\.preview/)).toBeNull()
  })
})
