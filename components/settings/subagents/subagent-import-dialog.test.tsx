/**
 * @jest-environment jsdom
 */

import React from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { SubagentImportDialog } from "./subagent-import-dialog"

// ---- Mocks --------------------------------------------------------------

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars) {
      return Object.entries(vars).reduce<string>(
        (acc, [k, v]) => acc.replace(`{${k}}`, String(v)),
        key
      )
    }
    return key
  },
}))

const isTauriMock = jest.fn(() => false)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

// Tauri plugin shims — invoked only on isTauriMock=true.
const tauriOpenMock = jest.fn()
const tauriReadTextMock = jest.fn()
const tauriReadDirMock = jest.fn()
jest.mock(
  "@tauri-apps/plugin-dialog",
  () => ({
    open: (...args: unknown[]) => tauriOpenMock(...args),
  }),
  { virtual: true }
)
jest.mock(
  "@tauri-apps/plugin-fs",
  () => ({
    readTextFile: (...args: unknown[]) => tauriReadTextMock(...args),
    readDir: (...args: unknown[]) => tauriReadDirMock(...args),
  }),
  { virtual: true }
)

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

const toastSuccess = jest.fn()
const toastWarning = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    warning: (...args: unknown[]) => toastWarning(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

const applyMock = jest.fn()
jest.mock("@/lib/claude/subagent-importers/apply", () => ({
  applySubagentImport: (args: unknown) => applyMock(args),
}))

// Replace heavy shadcn primitives with thin stubs so jsdom can drive them.
jest.mock("@/components/ui/dialog", () => {
  const Dialog = ({
    open,
    children,
  }: {
    open: boolean
    onOpenChange?: (v: boolean) => void
    children: React.ReactNode
  }) => (open ? <div role="dialog">{children}</div> : null)
  const Pass = ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) => (
    <div {...rest}>{children}</div>
  )
  return {
    Dialog,
    DialogContent: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    DialogDescription: Pass,
    DialogFooter: Pass,
  }
})

jest.mock("@/components/ui/radio-group", () => {
  const RadioGroup = ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (v: string) => void
    children: React.ReactNode
  }) => {
    return (
      <div data-rg-value={value}>
        {React.Children.map(children, (child) =>
          React.isValidElement(child)
            ? React.cloneElement(
                child as React.ReactElement,
                {
                  __rg: { value, onValueChange },
                } as Record<string, unknown>
              )
            : child
        )}
      </div>
    )
  }
  const RadioGroupItem = ({
    value,
    id,
    ...rest
  }: {
    value: string
    id?: string
    __rg?: { onValueChange: (v: string) => void; value: string }
  } & Record<string, unknown>) => {
    const __rg = (rest as { __rg?: { onValueChange: (v: string) => void } }).__rg
    return (
      <input
        type="radio"
        id={id}
        value={value}
        onClick={() => __rg?.onValueChange(value)}
        readOnly
      />
    )
  }
  return { RadioGroup, RadioGroupItem }
})

jest.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    ...rest
  }: {
    checked?: boolean
    onCheckedChange?: (v: boolean) => void
  } & Record<string, unknown>) => (
    <input
      type="checkbox"
      checked={!!checked}
      onChange={() => onCheckedChange?.(!checked)}
      {...rest}
    />
  ),
}))

jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) => (
    <div {...rest}>{children}</div>
  ),
}))

jest.mock("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}))

jest.mock("@/components/ui/badge", () => ({
  Badge: ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) => (
    <span {...rest}>{children}</span>
  ),
}))

jest.mock("@/components/ui/label", () => ({
  Label: ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) => (
    <label {...rest}>{children}</label>
  ),
}))

jest.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: React.PropsWithChildren<{
    onClick?: () => void
    disabled?: boolean
  }> &
    Record<string, unknown>) => (
    <button onClick={onClick} disabled={!!disabled} {...rest}>
      {children}
    </button>
  ),
}))

// ---- Tests --------------------------------------------------------------

const SAMPLE_FILE_CONTENT = `---
name: code-reviewer
description: Reviews code.
tools: Read, Grep
model: sonnet
---

You are a senior reviewer.
`

function makeFile(name: string, content: string, relPath?: string): File {
  const file = new File([content], name, { type: "text/markdown" })
  // jsdom's File polyfill is missing the `text()` method.
  Object.defineProperty(file, "text", {
    value: async () => content,
    configurable: true,
  })
  if (relPath !== undefined) {
    Object.defineProperty(file, "webkitRelativePath", { value: relPath })
  }
  return file
}

beforeEach(() => {
  applyMock.mockReset()
  toastSuccess.mockReset()
  toastWarning.mockReset()
  toastError.mockReset()
  isTauriMock.mockReturnValue(false)
  tauriOpenMock.mockReset()
  tauriReadTextMock.mockReset()
  tauriReadDirMock.mockReset()
})

describe("SubagentImportDialog", () => {
  it("renders source-step radios when opened", () => {
    render(<SubagentImportDialog open={true} onOpenChange={() => {}} />)
    expect(screen.getByTestId("subagent-import-step-source")).toBeInTheDocument()
    expect(screen.getByText("sources.auto")).toBeInTheDocument()
    expect(screen.getByText("sources.claude-code")).toBeInTheDocument()
    expect(screen.getByText("sources.generic-md")).toBeInTheDocument()
  })

  it("returns null when closed", () => {
    const { container } = render(<SubagentImportDialog open={false} onOpenChange={() => {}} />)
    expect(container.querySelector("[data-testid='subagent-import-dialog']")).toBeNull()
  })

  it("clicking Next advances to the file step", () => {
    render(<SubagentImportDialog open={true} onOpenChange={() => {}} />)
    fireEvent.click(screen.getByTestId("subagent-import-next"))
    expect(screen.getByTestId("subagent-import-step-files")).toBeInTheDocument()
  })

  it("uploading a file parses and advances to review", async () => {
    render(<SubagentImportDialog open={true} onOpenChange={() => {}} />)
    fireEvent.click(screen.getByTestId("subagent-import-next"))

    const input = screen.getByTestId("subagent-import-file-input") as HTMLInputElement
    const file = makeFile(
      "code-reviewer.md",
      SAMPLE_FILE_CONTENT,
      ".claude/agents/code-reviewer.md"
    )
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file], writable: false })
      fireEvent.change(input)
    })

    await waitFor(() =>
      expect(screen.getByTestId("subagent-import-step-review")).toBeInTheDocument()
    )
    expect(screen.getByText("code-reviewer")).toBeInTheDocument()
    expect(screen.getByText("Reviews code.")).toBeInTheDocument()
  })

  it("apply calls applySubagentImport with selected drafts and target/strategy", async () => {
    applyMock.mockResolvedValue({ imported: 1, skipped: 0, overwritten: 0, failed: [] })
    const onImported = jest.fn()
    const onOpenChange = jest.fn()
    render(<SubagentImportDialog open={true} onOpenChange={onOpenChange} onImported={onImported} />)
    fireEvent.click(screen.getByTestId("subagent-import-next"))

    const input = screen.getByTestId("subagent-import-file-input") as HTMLInputElement
    const file = makeFile(
      "code-reviewer.md",
      SAMPLE_FILE_CONTENT,
      ".claude/agents/code-reviewer.md"
    )
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file], writable: false })
      fireEvent.change(input)
    })
    await waitFor(() =>
      expect(screen.getByTestId("subagent-import-step-review")).toBeInTheDocument()
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId("subagent-import-apply"))
    })

    expect(applyMock).toHaveBeenCalledTimes(1)
    const args = applyMock.mock.calls[0][0]
    expect(args.target).toBe("subagent-template")
    expect(args.strategy).toBe("skip")
    expect(args.drafts).toHaveLength(1)
    expect(args.drafts[0].name).toBe("code-reviewer")
    expect(toastSuccess).toHaveBeenCalled()
    expect(onImported).toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("apply with failures surfaces a warning toast too", async () => {
    applyMock.mockResolvedValue({
      imported: 0,
      skipped: 0,
      overwritten: 0,
      failed: [{ name: "X", error: "oh no" }],
    })
    render(<SubagentImportDialog open={true} onOpenChange={() => {}} />)
    fireEvent.click(screen.getByTestId("subagent-import-next"))

    const input = screen.getByTestId("subagent-import-file-input") as HTMLInputElement
    const file = makeFile(
      "code-reviewer.md",
      SAMPLE_FILE_CONTENT,
      ".claude/agents/code-reviewer.md"
    )
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file], writable: false })
      fireEvent.change(input)
    })
    await waitFor(() =>
      expect(screen.getByTestId("subagent-import-step-review")).toBeInTheDocument()
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId("subagent-import-apply"))
    })
    expect(toastWarning).toHaveBeenCalled()
  })

  it("toggles draft selection", async () => {
    render(<SubagentImportDialog open={true} onOpenChange={() => {}} />)
    fireEvent.click(screen.getByTestId("subagent-import-next"))

    const input = screen.getByTestId("subagent-import-file-input") as HTMLInputElement
    const file = makeFile(
      "code-reviewer.md",
      SAMPLE_FILE_CONTENT,
      ".claude/agents/code-reviewer.md"
    )
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file], writable: false })
      fireEvent.change(input)
    })
    await waitFor(() =>
      expect(screen.getByTestId("subagent-import-step-review")).toBeInTheDocument()
    )

    const checkbox = screen.getByRole("checkbox") as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    fireEvent.click(checkbox)

    const applyBtn = screen.getByTestId("subagent-import-apply") as HTMLButtonElement
    expect(applyBtn.disabled).toBe(true)
  })

  it("upload with parse errors shows warnings header", async () => {
    render(<SubagentImportDialog open={true} onOpenChange={() => {}} />)
    fireEvent.click(screen.getByTestId("subagent-import-next"))

    const input = screen.getByTestId("subagent-import-file-input") as HTMLInputElement
    // Empty body — emits parse error
    const errFile = makeFile("broken.md", "---\nname: broken\n---\n", ".claude/agents/broken.md")
    await act(async () => {
      Object.defineProperty(input, "files", { value: [errFile], writable: false })
      fireEvent.change(input)
    })

    await waitFor(() =>
      expect(screen.getByTestId("subagent-import-step-review")).toBeInTheDocument()
    )
    expect(screen.getByText(/warningsHeader/i)).toBeInTheDocument()
    expect(screen.getByText(/Empty body/i)).toBeInTheDocument()
  })

  it("back button returns to source step", () => {
    render(<SubagentImportDialog open={true} onOpenChange={() => {}} />)
    fireEvent.click(screen.getByTestId("subagent-import-next"))
    expect(screen.getByTestId("subagent-import-step-files")).toBeInTheDocument()
    fireEvent.click(screen.getByText("back"))
    expect(screen.getByTestId("subagent-import-step-source")).toBeInTheDocument()
  })

  it("cancel closes the dialog and resets stage", () => {
    const onOpenChange = jest.fn()
    render(<SubagentImportDialog open={true} onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByText("cancel"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  describe("Tauri mode", () => {
    it("renders the Tauri pick UI and parses files via the FS plugin", async () => {
      isTauriMock.mockReturnValue(true)
      tauriOpenMock.mockResolvedValueOnce(["/abs/path/.claude/agents/code-reviewer.md"])
      tauriReadTextMock.mockResolvedValueOnce(SAMPLE_FILE_CONTENT)

      render(<SubagentImportDialog open={true} onOpenChange={() => {}} />)
      fireEvent.click(screen.getByTestId("subagent-import-next"))

      await act(async () => {
        fireEvent.click(screen.getByTestId("subagent-import-tauri-pick"))
      })
      await waitFor(() =>
        expect(screen.getByTestId("subagent-import-step-review")).toBeInTheDocument()
      )
      expect(screen.getByText("code-reviewer")).toBeInTheDocument()
      expect(tauriOpenMock).toHaveBeenCalled()
      expect(tauriReadTextMock).toHaveBeenCalledWith("/abs/path/.claude/agents/code-reviewer.md")
    })

    it("falls back to directory mode when file picker returns nothing", async () => {
      isTauriMock.mockReturnValue(true)
      tauriOpenMock
        .mockResolvedValueOnce(null) // file picker cancelled
        .mockResolvedValueOnce("/abs/path/.claude/agents") // dir picker
      tauriReadDirMock.mockResolvedValueOnce([
        { name: "code-reviewer.md", isFile: true },
        { name: "README.txt", isFile: true },
      ])
      tauriReadTextMock.mockResolvedValueOnce(SAMPLE_FILE_CONTENT)

      render(<SubagentImportDialog open={true} onOpenChange={() => {}} />)
      fireEvent.click(screen.getByTestId("subagent-import-next"))

      await act(async () => {
        fireEvent.click(screen.getByTestId("subagent-import-tauri-pick"))
      })
      await waitFor(() =>
        expect(screen.getByTestId("subagent-import-step-review")).toBeInTheDocument()
      )
      expect(tauriReadDirMock).toHaveBeenCalledWith("/abs/path/.claude/agents")
      expect(tauriReadTextMock).toHaveBeenCalledTimes(1)
    })

    it("a single string return is normalized into a one-element array", async () => {
      isTauriMock.mockReturnValue(true)
      tauriOpenMock.mockResolvedValueOnce("/abs/path/.claude/agents/single.md")
      tauriReadTextMock.mockResolvedValueOnce(SAMPLE_FILE_CONTENT)

      render(<SubagentImportDialog open={true} onOpenChange={() => {}} />)
      fireEvent.click(screen.getByTestId("subagent-import-next"))
      await act(async () => {
        fireEvent.click(screen.getByTestId("subagent-import-tauri-pick"))
      })
      await waitFor(() =>
        expect(screen.getByTestId("subagent-import-step-review")).toBeInTheDocument()
      )
    })

    it("logs a warning and keeps going when readTextFile throws on one file", async () => {
      isTauriMock.mockReturnValue(true)
      tauriOpenMock.mockResolvedValueOnce([
        "/abs/.claude/agents/ok.md",
        "/abs/.claude/agents/bad.md",
      ])
      tauriReadTextMock
        .mockResolvedValueOnce(SAMPLE_FILE_CONTENT)
        .mockRejectedValueOnce(new Error("permission denied"))

      render(<SubagentImportDialog open={true} onOpenChange={() => {}} />)
      fireEvent.click(screen.getByTestId("subagent-import-next"))
      await act(async () => {
        fireEvent.click(screen.getByTestId("subagent-import-tauri-pick"))
      })
      await waitFor(() =>
        expect(screen.getByTestId("subagent-import-step-review")).toBeInTheDocument()
      )
      // Only the ok file produced a draft.
      expect(screen.getAllByText(/code-reviewer/i)).toHaveLength(1)
    })

    it("stays on the file step when picker returns nothing and dir is also cancelled", async () => {
      isTauriMock.mockReturnValue(true)
      tauriOpenMock.mockResolvedValueOnce(null).mockResolvedValueOnce(null)

      render(<SubagentImportDialog open={true} onOpenChange={() => {}} />)
      fireEvent.click(screen.getByTestId("subagent-import-next"))
      await act(async () => {
        fireEvent.click(screen.getByTestId("subagent-import-tauri-pick"))
      })
      // Still on file step.
      expect(screen.getByTestId("subagent-import-step-files")).toBeInTheDocument()
    })

    it("toasts pickFailed when the dialog throws", async () => {
      isTauriMock.mockReturnValue(true)
      tauriOpenMock.mockRejectedValueOnce(new Error("dialog plugin not loaded"))

      render(<SubagentImportDialog open={true} onOpenChange={() => {}} />)
      fireEvent.click(screen.getByTestId("subagent-import-next"))
      await act(async () => {
        fireEvent.click(screen.getByTestId("subagent-import-tauri-pick"))
      })
      expect(toastError).toHaveBeenCalled()
    })
  })

  it("explicit source choice bypasses auto-detect", async () => {
    render(<SubagentImportDialog open={true} onOpenChange={() => {}} />)
    // Pick "claude-code" explicitly.
    const claudeRadio = document.getElementById(
      "subagent-import-src-claude-code"
    ) as HTMLInputElement
    fireEvent.click(claudeRadio)
    fireEvent.click(screen.getByTestId("subagent-import-next"))

    const input = screen.getByTestId("subagent-import-file-input") as HTMLInputElement
    const file = makeFile("code-reviewer.md", SAMPLE_FILE_CONTENT, "code-reviewer.md")
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file], writable: false })
      fireEvent.change(input)
    })
    await waitFor(() =>
      expect(screen.getByTestId("subagent-import-step-review")).toBeInTheDocument()
    )
  })

  it("apply throws — error is toasted", async () => {
    applyMock.mockRejectedValue(new Error("disk full"))
    render(<SubagentImportDialog open={true} onOpenChange={() => {}} />)
    fireEvent.click(screen.getByTestId("subagent-import-next"))
    const input = screen.getByTestId("subagent-import-file-input") as HTMLInputElement
    const file = makeFile(
      "code-reviewer.md",
      SAMPLE_FILE_CONTENT,
      ".claude/agents/code-reviewer.md"
    )
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file], writable: false })
      fireEvent.change(input)
    })
    await waitFor(() =>
      expect(screen.getByTestId("subagent-import-step-review")).toBeInTheDocument()
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId("subagent-import-apply"))
    })
    expect(toastError).toHaveBeenCalled()
  })
})
