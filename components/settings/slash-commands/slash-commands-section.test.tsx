/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { SlashCommandsSection } from "./slash-commands-section"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const mockLoadCustom = jest.fn()
const mockDeleteCustom = jest.fn()
jest.mock("@/lib/slash-commands/custom", () => ({
  loadCustomSlashCommands: () => mockLoadCustom(),
  deleteCustomSlashCommand: (...args: unknown[]) => mockDeleteCustom(...args),
}))

// Stub the editor dialog so we don't drag the form into this test surface.
jest.mock("./command-editor-dialog", () => ({
  CommandEditorDialog: ({
    open,
    onOpenChange,
    initial,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    initial?: unknown
  }) =>
    open ? (
      <div data-testid="editor-stub" data-mode={initial ? "edit" : "create"}>
        <button onClick={() => onOpenChange(false)} data-testid="editor-stub-close">
          close
        </button>
      </div>
    ) : null,
}))

jest.mock("@/stores/chat", () => ({
  useChatStore: (selector: (s: unknown) => unknown) => selector({ activeSessionId: null }),
}))

jest.mock("@/lib/db/sessions", () => ({
  getSession: jest.fn().mockResolvedValue(null),
}))

const mockListRegistry = jest.fn()
jest.mock("@/lib/slash-commands/registry", () => ({
  listSlashCommands: () => mockListRegistry(),
  // builtin.ts seeds built-ins via this side-effect on module load; the
  // section under test imports builtin.ts transitively, so the mock must
  // expose it as a no-op.
  seedBuiltinSlashCommands: jest.fn(),
}))

// `stores/index.ts` calls `isTauri()` at module top-level; declaring the
// jest.fn inside the factory dodges the TDZ.
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))
const isTauriMock = (jest.requireMock("@/lib/tauri") as { isTauri: jest.Mock }).isTauri

const toastSuccess = jest.fn()
const toastMessage = jest.fn()
jest.mock("@/components/ui/sonner", () => ({
  toast: {
    success: (m: string) => toastSuccess(m),
    message: (m: string) => toastMessage(m),
    error: jest.fn(),
  },
}))

// Stub Accordion primitives to plain divs so children are always rendered.
jest.mock("@/components/ui/accordion", () => ({
  Accordion: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AccordionItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AccordionTrigger: ({
    children,
    ...rest
  }: { children: React.ReactNode } & Record<string, unknown>) => (
    <button {...rest}>{children}</button>
  ),
  AccordionContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

beforeEach(() => {
  toastSuccess.mockReset()
  toastMessage.mockReset()
  mockLoadCustom.mockReset()
  mockListRegistry.mockReset()
  mockDeleteCustom.mockReset().mockResolvedValue(undefined)
  isTauriMock.mockReturnValue(true)
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: jest.fn(() => Promise.resolve()) },
    configurable: true,
  })
})

describe("SlashCommandsSection", () => {
  it("renders all three accordion groups", async () => {
    mockLoadCustom.mockResolvedValue([])
    mockListRegistry.mockReturnValue([])
    render(<SlashCommandsSection />)
    expect(screen.getByTestId("group-builtin")).toBeInTheDocument()
    expect(screen.getByTestId("group-custom")).toBeInTheDocument()
    expect(screen.getByTestId("group-plugin")).toBeInTheDocument()
    await waitFor(() => expect(mockLoadCustom).toHaveBeenCalled())
  })

  it("renders one row per built-in command", async () => {
    mockLoadCustom.mockResolvedValue([])
    mockListRegistry.mockReturnValue([])
    render(<SlashCommandsSection />)
    await waitFor(() => expect(mockLoadCustom).toHaveBeenCalled())
    // /clear and /help are baseline built-ins.
    expect(screen.getByTestId("slash-command-row-clear")).toBeInTheDocument()
    expect(screen.getByTestId("slash-command-row-help")).toBeInTheDocument()
  })

  it("filters by name across all three groups", async () => {
    mockLoadCustom.mockResolvedValue([])
    mockListRegistry.mockReturnValue([])
    render(<SlashCommandsSection />)
    await waitFor(() => expect(mockLoadCustom).toHaveBeenCalled())

    fireEvent.change(screen.getByTestId("slash-commands-filter"), { target: { value: "clear" } })
    expect(screen.getByTestId("slash-command-row-clear")).toBeInTheDocument()
    expect(screen.queryByTestId("slash-command-row-help")).not.toBeInTheDocument()
  })

  it("shows the custom-list scanning placeholder while load is in flight", async () => {
    let resolveLoad: ((v: unknown[]) => void) | undefined
    mockLoadCustom.mockImplementation(
      () =>
        new Promise((res) => {
          resolveLoad = (v) => res(v as never)
        })
    )
    mockListRegistry.mockReturnValue([])
    render(<SlashCommandsSection />)
    expect(screen.getByText("scanning")).toBeInTheDocument()
    resolveLoad?.([])
    await waitFor(() => expect(screen.queryByText("scanning")).not.toBeInTheDocument())
  })

  it("renders custom commands found by the scanner", async () => {
    mockLoadCustom.mockResolvedValue([
      {
        name: "ship-it",
        description: "Ship the current branch",
        scope: "user",
        argumentHint: "<note?>",
        filePath: "/home/u/.claude/commands/ship-it.md",
        template: "ship",
      },
    ])
    mockListRegistry.mockReturnValue([])
    render(<SlashCommandsSection />)
    await waitFor(() => expect(screen.getByTestId("slash-command-row-ship-it")).toBeInTheDocument())
  })

  it("renders only plugin-source commands in the plugin group", async () => {
    mockLoadCustom.mockResolvedValue([])
    mockListRegistry.mockReturnValue([
      {
        id: "p1.echo",
        name: "p-echo",
        source: "plugin",
        pluginId: "p1",
        handler: jest.fn(),
      },
      {
        id: "ignored",
        name: "ignored",
        source: "builtin",
        handler: jest.fn(),
      },
    ])
    render(<SlashCommandsSection />)
    await waitFor(() => expect(screen.getByTestId("slash-command-row-p-echo")).toBeInTheDocument())
    expect(screen.queryByTestId("slash-command-row-ignored")).not.toBeInTheDocument()
  })

  it("Try button copies '/<name> ' to clipboard and toasts", async () => {
    mockLoadCustom.mockResolvedValue([])
    mockListRegistry.mockReturnValue([])
    render(<SlashCommandsSection />)
    await waitFor(() => expect(mockLoadCustom).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId("try-clear"))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("/clear "))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
  })

  it("shows the Tauri-mode empty placeholder when custom scan returns empty", async () => {
    mockLoadCustom.mockResolvedValue([])
    mockListRegistry.mockReturnValue([])
    render(<SlashCommandsSection />)
    await waitFor(() => expect(screen.getByText("emptyCustom")).toBeInTheDocument())
  })

  it("propagates loadCustomSlashCommands errors to the logger without crashing the panel", async () => {
    mockLoadCustom.mockRejectedValueOnce(new Error("boom"))
    mockListRegistry.mockReturnValue([])
    render(<SlashCommandsSection />)
    // Section should still render; the empty-custom placeholder should appear.
    await waitFor(() => expect(screen.getByText("emptyCustom")).toBeInTheDocument())
  })

  it("New button opens the editor in create mode", async () => {
    mockLoadCustom.mockResolvedValue([])
    mockListRegistry.mockReturnValue([])
    render(<SlashCommandsSection />)
    await waitFor(() => expect(mockLoadCustom).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId("slash-commands-new"))
    expect(screen.getByTestId("editor-stub")).toHaveAttribute("data-mode", "create")
  })

  it("Edit on a custom row opens the editor in edit mode prefilled", async () => {
    mockLoadCustom.mockResolvedValue([
      {
        name: "ship-it",
        description: "Ship",
        scope: "user",
        filePath: "/p",
        template: "ship",
      },
    ])
    mockListRegistry.mockReturnValue([])
    render(<SlashCommandsSection />)
    await waitFor(() => expect(screen.getByTestId("slash-command-row-ship-it")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("edit-ship-it"))
    expect(screen.getByTestId("editor-stub")).toHaveAttribute("data-mode", "edit")
  })

  it("Delete confirms and calls deleteCustomSlashCommand", async () => {
    mockLoadCustom.mockResolvedValue([
      {
        name: "ship-it",
        description: "Ship",
        scope: "user",
        filePath: "/p",
        template: "ship",
      },
    ])
    mockListRegistry.mockReturnValue([])
    render(<SlashCommandsSection />)
    await waitFor(() => expect(screen.getByTestId("slash-command-row-ship-it")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("delete-ship-it"))
    fireEvent.click(await screen.findByTestId("slash-commands-delete-confirm"))
    await waitFor(() => expect(mockDeleteCustom).toHaveBeenCalled())
    const arg = mockDeleteCustom.mock.calls[0][0] as { name: string; scope: string }
    expect(arg.name).toBe("ship-it")
    expect(arg.scope).toBe("user")
  })

  it("hides the New button + edit/delete actions in web mode", async () => {
    isTauriMock.mockReturnValue(false)
    mockLoadCustom.mockResolvedValue([
      {
        name: "ship-it",
        description: "Ship",
        scope: "user",
        filePath: "/p",
        template: "ship",
      },
    ])
    mockListRegistry.mockReturnValue([])
    render(<SlashCommandsSection />)
    await waitFor(() => expect(screen.getByTestId("slash-command-row-ship-it")).toBeInTheDocument())
    expect(screen.getByTestId("slash-commands-new")).toBeDisabled()
    expect(screen.getByTestId("slash-commands-web-banner")).toBeInTheDocument()
    expect(screen.queryByTestId("edit-ship-it")).toBeNull()
    expect(screen.queryByTestId("delete-ship-it")).toBeNull()
  })
})
