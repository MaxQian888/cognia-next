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
  loadCustomSlashCommands: (...args: unknown[]) => mockLoadCustom(...args),
  deleteCustomSlashCommand: (...args: unknown[]) => mockDeleteCustom(...args),
  projectCommandDirOf: (originDir?: string | null) =>
    originDir?.includes("/.cognia/") ? ".cognia/commands" : ".claude/commands",
}))

// The authoring gate is the host profile, not `isTauri()`. A paired browser
// reaches this repository's `.claude/commands` over the workspace filesystem,
// and a jsdom process is neither a desktop nor a companion.
const mockHostProfile = jest.fn(() => "desktop")
jest.mock("@/hooks/use-host-profile", () => ({
  useHostProfile: () => mockHostProfile(),
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

jest.mock("@/stores/chat", () => {
  const state = { activeSessionId: null as string | null }
  return {
    useChatStore: (selector: (s: unknown) => unknown) => selector(state),
    __setActiveSessionId: (id: string | null) => {
      state.activeSessionId = id
    },
  }
})
const { __setActiveSessionId } = jest.requireMock("@/stores/chat") as {
  __setActiveSessionId: (id: string | null) => void
}

jest.mock("@/lib/db/sessions", () => ({
  getSession: jest.fn().mockResolvedValue(null),
}))
const getSessionMock = (jest.requireMock("@/lib/db/sessions") as { getSession: jest.Mock })
  .getSession

// The section resolves the *effective* cwd (session → workspace → character →
// default) — stub the resolver so the test controls what it yields.
jest.mock("@/hooks/chat/use-effective-cwd", () => ({
  resolveEffectiveCwdForSession: jest.fn(async () => null),
}))
const resolveEffectiveCwdMock = (
  jest.requireMock("@/hooks/chat/use-effective-cwd") as {
    resolveEffectiveCwdForSession: jest.Mock
  }
).resolveEffectiveCwdForSession

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
  mockHostProfile.mockReturnValue("desktop")
  __setActiveSessionId(null)
  getSessionMock.mockResolvedValue(null)
  resolveEffectiveCwdMock.mockReset().mockResolvedValue(null)
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: jest.fn(() => Promise.resolve()) },
    configurable: true,
  })
})

describe("SlashCommandsSection", () => {
  it("scans commands with the effective cwd (workspace fallback) instead of raw session.workingDir", async () => {
    mockLoadCustom.mockResolvedValue([])
    mockListRegistry.mockReturnValue([])
    __setActiveSessionId("s1")
    const sessionRow = { id: "s1" } // no workingDir — the workspace supplies it
    getSessionMock.mockResolvedValue(sessionRow)
    resolveEffectiveCwdMock.mockResolvedValue("/ws/root")
    render(<SlashCommandsSection />)
    await waitFor(() => expect(resolveEffectiveCwdMock).toHaveBeenCalledWith(sessionRow))
    // The cwd-keyed scan effect re-runs with the resolved workspace root.
    await waitFor(() => expect(mockLoadCustom).toHaveBeenCalledWith("/ws/root"))
  })

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

  /**
   * Render, disable, explain. Hiding these collapsed three different answers
   * into one silence: nothing paired, one pairing away, and desktop-only.
   */
  it("disables rather than hides authoring when nothing is paired", async () => {
    mockHostProfile.mockReturnValue("web-standalone")
    mockLoadCustom.mockResolvedValue([
      { name: "ship-it", description: "Ship", scope: "user", filePath: "/p", template: "ship" },
    ])
    mockListRegistry.mockReturnValue([])
    render(<SlashCommandsSection />)
    await waitFor(() => expect(screen.getByTestId("slash-command-row-ship-it")).toBeInTheDocument())
    expect(screen.getByTestId("slash-commands-new")).toBeDisabled()
    expect(screen.getByTestId("slash-commands-web-banner")).toBeInTheDocument()
    expect(screen.getByTestId("slash-commands-project-block")).toHaveTextContent("authoring.noHost")
    expect(screen.getByTestId("edit-ship-it")).toBeDisabled()
    expect(screen.getByTestId("delete-ship-it")).toBeDisabled()
    expect(screen.getByTestId("blocked-ship-it")).toBeInTheDocument()
  })

  it("lets a paired browser author project commands and explains the global scope", async () => {
    mockHostProfile.mockReturnValue("cloud-companion")
    __setActiveSessionId("s1")
    getSessionMock.mockResolvedValue({ id: "s1" })
    resolveEffectiveCwdMock.mockResolvedValue("/ws/root")
    mockLoadCustom.mockResolvedValue([
      {
        name: "proj",
        description: "P",
        scope: "project",
        filePath: ".claude/commands/proj.md",
        template: "p",
      },
      { name: "glob", description: "G", scope: "user", filePath: "/p", template: "g" },
    ])
    mockListRegistry.mockReturnValue([])
    render(<SlashCommandsSection />)
    await waitFor(() => expect(screen.getByTestId("slash-command-row-proj")).toBeInTheDocument())

    // Project scope works over the pairing.
    expect(screen.getByTestId("edit-proj")).toBeEnabled()
    expect(screen.getByTestId("delete-proj")).toBeEnabled()
    expect(screen.queryByTestId("blocked-proj")).toBeNull()
    expect(screen.getByTestId("slash-commands-new")).toBeEnabled()
    // The user's home directory does not, and the row says so.
    expect(screen.getByTestId("edit-glob")).toBeDisabled()
    expect(screen.getByTestId("blocked-glob")).toHaveTextContent("authoring.needsDesktop")
  })

  it("says a project command needs a workspace before it says anything else", async () => {
    mockHostProfile.mockReturnValue("cloud-companion")
    mockLoadCustom.mockResolvedValue([
      {
        name: "proj",
        description: "P",
        scope: "project",
        filePath: ".claude/commands/proj.md",
        template: "p",
      },
    ])
    mockListRegistry.mockReturnValue([])
    render(<SlashCommandsSection />)
    await waitFor(() => expect(screen.getByTestId("slash-command-row-proj")).toBeInTheDocument())
    expect(screen.getByTestId("blocked-proj")).toHaveTextContent("authoring.projectNeedsWorkspace")
  })

  it("deletes from the directory the command was read from", async () => {
    __setActiveSessionId("s1")
    getSessionMock.mockResolvedValue({ id: "s1" })
    resolveEffectiveCwdMock.mockResolvedValue("/ws/root")
    mockLoadCustom.mockResolvedValue([
      {
        name: "ship-it",
        description: "Ship",
        scope: "project",
        filePath: "/ws/root/.cognia/commands/ship-it.md",
        originDir: "/ws/root/.cognia/commands",
        template: "ship",
      },
    ])
    mockListRegistry.mockReturnValue([])
    render(<SlashCommandsSection />)
    await waitFor(() => expect(screen.getByTestId("slash-command-row-ship-it")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("delete-ship-it"))
    fireEvent.click(await screen.findByTestId("slash-commands-delete-confirm"))
    await waitFor(() => expect(mockDeleteCustom).toHaveBeenCalled())
    expect(mockDeleteCustom.mock.calls[0][0]).toMatchObject({
      name: "ship-it",
      scope: "project",
      dir: ".cognia/commands",
    })
  })
})
