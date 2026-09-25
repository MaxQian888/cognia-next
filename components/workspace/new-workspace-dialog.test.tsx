import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Project } from "@/types"

const commandGate = jest.fn(() => ({ available: true, reason: null as string | null }))
const nativePicker = jest.fn(async () => null as string | null)
const desktop = jest.fn(() => false)
jest.mock("@/lib/tauri", () => ({ isTauri: () => desktop() }))
jest.mock("@/lib/files/file-bridge", () => ({ pickDirectory: () => nativePicker() }))
jest.mock("@/hooks/workspace/use-workspace-command-gate", () => ({
  useWorkspaceCommandGate: () => commandGate,
}))
jest.mock("@/hooks/use-workspace-action-controller", () => ({
  useWorkspaceActionController: () => ({ describe: (error: Error) => error.message }),
}))
jest.mock("@/lib/workspace/host-approved-fs", () => ({
  createApprovedWorkspaceDir: jest.fn(),
  initApprovedGitRepository: jest.fn(),
}))
jest.mock("@/components/shell/workspace-folder-picker", () => ({
  WorkspaceFolderPicker: ({
    open,
    onSelect,
  }: {
    open: boolean
    onSelect: (path: string) => void
  }) =>
    open ? (
      <button onClick={() => onSelect("/host/workspaces/team")}>Select host folder</button>
    ) : null,
}))
jest.mock("sonner", () => ({ toast: { warning: jest.fn() } }))

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (sel: (s: { settings: { projectsRoot?: string } }) => unknown) =>
    sel({ settings: { projectsRoot: "/Users/x/Projects" } }),
}))
jest.mock("@/lib/files/workspace-fs", () => ({ createWorkspaceDir: jest.fn() }))
jest.mock("@/lib/git/commands", () => ({ gitInit: jest.fn() }))
jest.mock("@/lib/workspace/open-folder", () => ({ openPathAsWorkspace: jest.fn() }))

import { NewWorkspaceDialog } from "./new-workspace-dialog"
import { toast } from "sonner"

const project = { id: "project-new", name: "My App" } as unknown as Project

function setup(over: Partial<Parameters<typeof NewWorkspaceDialog>[0]> = {}) {
  const deps = {
    createDir: jest.fn(async () => undefined),
    initGit: jest.fn(async () => undefined),
    openAsWorkspace: jest.fn(() => project),
  }
  const onCreated = jest.fn()
  const onOpenChange = jest.fn()
  render(
    <NewWorkspaceDialog
      open
      onOpenChange={onOpenChange}
      onCreated={onCreated}
      deps={deps}
      resolveParent={async () => "/Users/x/Projects"}
      {...over}
    />
  )
  return { deps, onCreated, onOpenChange }
}

async function typeName(value: string) {
  fireEvent.change(screen.getByTestId("new-workspace-name"), { target: { value } })
  await waitFor(() => expect(screen.getByTestId("new-workspace-path")).toBeInTheDocument())
}

describe("NewWorkspaceDialog", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    desktop.mockReturnValue(false)
    commandGate.mockReturnValue({ available: true, reason: null })
  })

  it("browses the host and creates in the selected parent from a web client", async () => {
    const { deps } = setup()
    fireEvent.click(screen.getByRole("button", { name: "browse" }))
    // The lightweight picker stub is outside the parent Radix portal.
    fireEvent.click(await screen.findByRole("button", { name: "Select host folder", hidden: true }))
    expect(screen.getByLabelText("parentLabel")).toHaveValue("/host/workspaces/team")
    await typeName("My App")
    fireEvent.click(screen.getByRole("button", { name: "submit" }))
    await waitFor(() =>
      expect(deps.createDir).toHaveBeenCalledWith("/host/workspaces/team", "My App")
    )
    expect(nativePicker).not.toHaveBeenCalled()
  })

  it("explains why creation is unavailable before making any filesystem request", async () => {
    commandGate.mockReturnValue({ available: false, reason: "Connect to your host" })
    const { deps } = setup()
    await typeName("My App")
    expect(screen.getByRole("button", { name: "submit" })).toBeDisabled()
    expect(screen.getByText("Connect to your host")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "browse" })).not.toBeInTheDocument()
    expect(deps.createDir).not.toHaveBeenCalled()
  })

  it("keeps the git warning visible after the created workspace closes the dialog", async () => {
    const { onOpenChange } = setup({
      deps: {
        createDir: jest.fn(async () => undefined),
        initGit: jest.fn(async () => {
          throw new Error("git missing")
        }),
        openAsWorkspace: jest.fn(() => project),
      },
    })
    await typeName("My App")
    fireEvent.click(screen.getByRole("button", { name: "submit" }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(toast.warning).toHaveBeenCalledWith("errors.gitInitFailed", {
      description: "git missing",
    })
  })

  it("seeds the parent from the configured projects root", async () => {
    setup()
    await waitFor(() =>
      expect(screen.getByLabelText("parentLabel")).toHaveValue("/Users/x/Projects")
    )
  })

  it("shows the exact path before anything is written", async () => {
    setup()
    await waitFor(() =>
      expect(screen.getByLabelText("parentLabel")).toHaveValue("/Users/x/Projects")
    )
    await typeName("My App: v2")
    // The sanitizer rewrote the name — the user sees that, rather than finding
    // out after the folder exists.
    expect(screen.getByTestId("new-workspace-path")).toHaveTextContent(
      "/Users/x/Projects/My App- v2"
    )
  })

  it("creates, initialises git, and reports the new workspace", async () => {
    const { deps, onCreated, onOpenChange } = setup()
    await waitFor(() =>
      expect(screen.getByLabelText("parentLabel")).toHaveValue("/Users/x/Projects")
    )
    await typeName("My App")
    fireEvent.click(screen.getByRole("button", { name: "submit" }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("project-new"))
    expect(deps.createDir).toHaveBeenCalledWith("/Users/x/Projects", "My App")
    expect(deps.initGit).toHaveBeenCalledWith("/Users/x/Projects/My App")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("keeps the dialog open and explains a failed mkdir", async () => {
    const { onCreated } = setup({
      deps: {
        createDir: jest.fn(async () => {
          throw new Error("EACCES")
        }),
        initGit: jest.fn(),
        openAsWorkspace: jest.fn(() => project),
      },
    })
    await waitFor(() =>
      expect(screen.getByLabelText("parentLabel")).toHaveValue("/Users/x/Projects")
    )
    await typeName("My App")
    fireEvent.click(screen.getByRole("button", { name: "submit" }))

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("errors.mkdir-failed"))
    expect(screen.getByRole("alert")).toHaveTextContent("EACCES")
    expect(onCreated).not.toHaveBeenCalled()
  })

  it("refuses to submit without a name", async () => {
    setup()
    await waitFor(() =>
      expect(screen.getByLabelText("parentLabel")).toHaveValue("/Users/x/Projects")
    )
    expect(screen.getByRole("button", { name: "submit" })).toBeDisabled()
  })

  /** On a short window the form scrolls inside the dialog instead of off-screen. */
  it("caps the dialog's height and scrolls its content", async () => {
    setup()
    await waitFor(() =>
      expect(screen.getByLabelText("parentLabel")).toHaveValue("/Users/x/Projects")
    )
    expect(screen.getByTestId("new-workspace-dialog")).toHaveClass(
      "max-h-[85dvh]",
      "overflow-y-auto"
    )
  })
})
