import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Project } from "@/types"

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (sel: (s: { settings: { projectsRoot?: string } }) => unknown) =>
    sel({ settings: { projectsRoot: "/Users/x/Projects" } }),
}))
jest.mock("@/lib/files/workspace-fs", () => ({ createWorkspaceDir: jest.fn() }))
jest.mock("@/lib/git/commands", () => ({ gitInit: jest.fn() }))
jest.mock("@/lib/workspace/open-folder", () => ({ openPathAsWorkspace: jest.fn() }))

import { NewWorkspaceDialog } from "./new-workspace-dialog"

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
    expect(onCreated).not.toHaveBeenCalled()
  })

  it("refuses to submit without a name", async () => {
    setup()
    await waitFor(() =>
      expect(screen.getByLabelText("parentLabel")).toHaveValue("/Users/x/Projects")
    )
    expect(screen.getByRole("button", { name: "submit" })).toBeDisabled()
  })
})
