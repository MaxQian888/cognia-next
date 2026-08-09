import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const probeVendors = jest.fn()
const buildMigrationPreview = jest.fn()
const applyMigration = jest.fn()

jest.mock("@/lib/agent-migration", () => ({
  MIGRATION_ARTIFACTS: ["settings", "sessions", "skills", "subagents", "mcp", "commands", "memory"],
  probeVendors: (...args: unknown[]) => probeVendors(...args),
  buildMigrationPreview: (...args: unknown[]) => buildMigrationPreview(...args),
  applyMigration: (...args: unknown[]) => applyMigration(...args),
}))

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector({
      activeProjectId: "project-1",
      projects: [{ id: "project-1", roots: [{ path: "/workspace", kind: "primary" }] }],
    }),
}))

jest.mock("@/lib/workspace/roots", () => ({
  primaryRootOf: (project: { roots: Array<{ path: string }> }) => project.roots[0],
}))

beforeEach(() => {
  jest.clearAllMocks()
  probeVendors.mockResolvedValue([
    { vendor: "claude-code", installed: true },
    { vendor: "codex", installed: true },
    { vendor: "opencode", installed: false },
  ])
  buildMigrationPreview.mockResolvedValue({
    vendor: "codex",
    artifacts: {
      settings: { artifact: "settings", status: "ready", count: 2, warnings: [], items: [{}, {}] },
      sessions: { artifact: "sessions", status: "empty", count: 0, warnings: [], items: [] },
    },
  })
  applyMigration.mockResolvedValue({
    vendor: "codex",
    aborted: false,
    artifacts: {
      settings: { imported: 2, warnings: [] },
      sessions: { imported: 0, skipped: 0, warnings: [] },
    },
  })
})

describe("AgentMigrationDialog", () => {
  async function openArtifacts() {
    const { AgentMigrationDialog } = await import("./agent-migration-dialog")
    const user = userEvent.setup()
    render(<AgentMigrationDialog trigger={<button>Open migration</button>} />)
    await user.click(screen.getByRole("button", { name: "Open migration" }))
    await waitFor(() => expect(probeVendors).toHaveBeenCalled())
    await user.click(screen.getByRole("button", { name: /Codex/ }))
    await user.click(screen.getByRole("button", { name: "Continue" }))
    return user
  }

  it("probes vendors, previews selected artifacts, and applies the migration", async () => {
    const { AgentMigrationDialog } = await import("./agent-migration-dialog")
    const user = userEvent.setup()
    render(<AgentMigrationDialog trigger={<button>Open migration</button>} />)

    await user.click(screen.getByRole("button", { name: "Open migration" }))
    await waitFor(() => expect(probeVendors).toHaveBeenCalled())
    expect(screen.getByRole("button", { name: /OpenCode/ })).toBeDisabled()

    await user.click(screen.getByRole("button", { name: /Codex/ }))
    await user.click(screen.getByRole("button", { name: "Continue" }))
    await user.click(screen.getByRole("checkbox", { name: "Skills" }))
    await user.click(screen.getByRole("checkbox", { name: "Subagents" }))
    await user.click(screen.getByRole("checkbox", { name: "MCP servers" }))
    await user.click(screen.getByRole("checkbox", { name: "Commands" }))
    await user.click(screen.getByRole("checkbox", { name: "Memory" }))
    await user.click(screen.getByRole("button", { name: "Preview" }))

    await waitFor(() =>
      expect(buildMigrationPreview).toHaveBeenCalledWith(
        "codex",
        ["settings", "sessions"],
        undefined,
        { cwd: "/workspace" }
      )
    )
    expect(screen.getByText("2 items")).toBeInTheDocument()

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Conflict handling" }),
      "overwrite"
    )
    await user.click(screen.getByRole("button", { name: "Import" }))

    await waitFor(() => expect(applyMigration).toHaveBeenCalled())
    expect(applyMigration.mock.calls[0][0]).toMatchObject({
      vendor: "codex",
      artifacts: ["settings", "sessions"],
      strategy: "overwrite",
      cwd: "/workspace",
      projectId: "project-1",
    })
    expect(await screen.findByText("Migration complete")).toBeInTheDocument()
    expect(screen.getByText("2 imported")).toBeInTheDocument()
  })

  it("shows probe failures and allows retrying", async () => {
    probeVendors.mockRejectedValueOnce(new Error("probe failed"))
    const { AgentMigrationDialog } = await import("./agent-migration-dialog")
    const user = userEvent.setup()
    render(<AgentMigrationDialog trigger={<button>Open migration</button>} />)

    await user.click(screen.getByRole("button", { name: "Open migration" }))
    expect(
      await screen.findByText("Installed coding agents could not be detected.")
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Try again" }))
    await waitFor(() => expect(probeVendors).toHaveBeenCalledTimes(2))
  })

  it("localizes preview failures", async () => {
    buildMigrationPreview.mockRejectedValueOnce(new Error("raw preview failure"))
    const user = await openArtifacts()

    await user.click(screen.getByRole("button", { name: "Preview" }))

    expect(
      await screen.findByText("The migration preview could not be created.")
    ).toBeInTheDocument()
  })

  it("localizes apply failures", async () => {
    applyMigration.mockRejectedValueOnce(new Error("raw apply failure"))
    const user = await openArtifacts()
    await user.click(screen.getByRole("button", { name: "Preview" }))
    await screen.findByText("2 items")

    await user.click(screen.getByRole("button", { name: "Import" }))

    expect(await screen.findByText("The migration could not be completed.")).toBeInTheDocument()
  })

  it("does not expose raw per-artifact errors", async () => {
    applyMigration.mockResolvedValueOnce({
      vendor: "codex",
      aborted: false,
      artifacts: {
        settings: { imported: 0, warnings: [], error: "raw database detail" },
      },
    })
    const user = await openArtifacts()
    await user.click(screen.getByRole("button", { name: "Preview" }))
    await screen.findByText("2 items")

    await user.click(screen.getByRole("button", { name: "Import" }))

    expect(await screen.findByText("This item could not be imported.")).toBeInTheDocument()
    expect(screen.queryByText("raw database detail")).not.toBeInTheDocument()
  })
})
