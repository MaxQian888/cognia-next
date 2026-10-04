/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

// A paired phone: no Tauri shell, but a companion link to the Host. Every
// workspace read must therefore travel over `transport.call`.
jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
  transport: { call: jest.fn() },
}))
jest.mock("@/lib/tauri/transport-companion", () => ({
  loadCompanionConfig: () => ({ baseUrl: "https://host.example", token: "t" }),
}))
jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}:${JSON.stringify(values)}` : `${namespace}.${key}`,
}))
jest.mock("@/components/shared/file-type-icon", () => ({
  FileTypeIcon: () => <span data-testid="file-type-icon" />,
}))
jest.mock("@/components/editor/light-code-editor", () => ({
  LightCodeEditor: ({
    value,
    language,
    readOnly,
    "data-testid": testId,
  }: {
    value: string
    language: string
    readOnly?: boolean
    "data-testid"?: string
  }) => (
    <pre data-testid={testId} data-language={language} data-readonly={String(readOnly)}>
      {value}
    </pre>
  ),
}))

import { transport } from "@/lib/tauri"
import { MAX_VIEWER_BYTES } from "@/lib/file-viewer/probe"
import { WorkspaceFilePreview } from "./workspace-file-preview"

const callMock = transport.call as jest.Mock

function hostWith(files: Record<string, string | Error>) {
  callMock.mockImplementation(async (command: string, args: { relPath: string }) => {
    const entry = files[args.relPath]
    if (command === "fs_stat_workspace_file") {
      if (entry instanceof Error) throw entry
      return entry === undefined
        ? { exists: false, isDir: false, size: 0 }
        : { exists: true, isDir: false, size: entry.length }
    }
    if (command === "fs_read_workspace_file") {
      if (entry instanceof Error) throw entry
      return entry
    }
    throw new Error(`unexpected ${command}`)
  })
}

const renderPreview = (props: Partial<Parameters<typeof WorkspaceFilePreview>[0]> = {}) => {
  const onBack = jest.fn()
  const onOpenInEditor = jest.fn()
  render(
    <WorkspaceFilePreview
      root="/host/workspaces/d8dc6c5dd314824c470e7aed"
      relPath="components/mobile/external-agents/add-external-agent-form.tsx"
      onBack={onBack}
      onOpenInEditor={onOpenInEditor}
      {...props}
    />
  )
  return { onBack, onOpenInEditor }
}

beforeEach(() => {
  callMock.mockReset()
})

describe("WorkspaceFilePreview", () => {
  it("reads the file from the Host over the companion transport and renders it read-only", async () => {
    hostWith({
      "components/mobile/external-agents/add-external-agent-form.tsx":
        "export function Form() {}\n",
    })
    renderPreview({ line: 12 })

    expect(screen.getByTestId("workspace-file-preview-loading")).toBeInTheDocument()
    const content = await screen.findByTestId("workspace-file-preview-content")
    expect(content).toHaveTextContent("export function Form() {}")
    expect(content).toHaveAttribute("data-readonly", "true")
    // Syntax highlighting follows the path, as in the mobile project editor.
    expect(content).toHaveAttribute("data-language", "typescript")

    expect(callMock).toHaveBeenCalledWith("fs_stat_workspace_file", {
      root: "/host/workspaces/d8dc6c5dd314824c470e7aed",
      relPath: "components/mobile/external-agents/add-external-agent-form.tsx",
    })
    expect(callMock).toHaveBeenCalledWith("fs_read_workspace_file", {
      root: "/host/workspaces/d8dc6c5dd314824c470e7aed",
      relPath: "components/mobile/external-agents/add-external-agent-form.tsx",
      maxBytes: MAX_VIEWER_BYTES + 1,
    })
    // The long path is truncated in the header rather than widening the sheet.
    const name = screen.getByTestId("workspace-file-preview-name")
    expect(name).toHaveTextContent("add-external-agent-form.tsx:12")
    expect(name).toHaveClass("truncate")
    expect(screen.getByTestId("workspace-file-preview")).toHaveClass(
      "min-w-0",
      "max-w-full",
      "overflow-hidden"
    )
  })

  it("shows the failure with a retry that reads again", async () => {
    let fail = true
    callMock.mockImplementation(async (command: string) => {
      if (fail) throw new Error("companion offline")
      return command === "fs_stat_workspace_file" ? { exists: true, isDir: false, size: 3 } : "ok\n"
    })
    renderPreview()

    const error = await screen.findByTestId("workspace-file-preview-error")
    expect(error).toHaveAttribute("data-error-code", "read-failed")
    expect(error).toHaveTextContent("fileViewer.error.readFailed")

    fail = false
    fireEvent.click(screen.getByTestId("workspace-file-preview-retry"))
    expect(await screen.findByTestId("workspace-file-preview-content")).toHaveTextContent("ok")
  })

  it("names a missing file instead of going blank", async () => {
    hostWith({})
    renderPreview()
    expect(await screen.findByTestId("workspace-file-preview-error")).toHaveAttribute(
      "data-error-code",
      "not-found"
    )
  })

  it("renders an explicit empty state for an empty file", async () => {
    hostWith({ "components/mobile/external-agents/add-external-agent-form.tsx": "" })
    renderPreview()
    expect(await screen.findByTestId("workspace-file-preview-empty")).toHaveTextContent(
      "artifacts.workspace.filePreview.emptyFile"
    )
  })

  it("goes back or hands the file to the editor", async () => {
    hostWith({ "components/mobile/external-agents/add-external-agent-form.tsx": "x" })
    const { onBack, onOpenInEditor } = renderPreview()
    await waitFor(() => expect(screen.getByTestId("workspace-file-preview-content")).toBeVisible())

    fireEvent.click(screen.getByTestId("workspace-file-preview-edit"))
    expect(onOpenInEditor).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "artifacts.workspace.filePreview.back" }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
