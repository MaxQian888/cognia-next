import * as ReactForMock from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// Render shadcn Select as a native <select> so the existing `selectOptions`
// assertion keeps driving the real value change. Mirrors
// `components/settings/appearance/components/usage-display-card.test.tsx`.
jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (v: string) => void
    children: React.ReactNode
  }) =>
    ReactForMock.createElement(
      "select",
      {
        "aria-label": "Conflict handling",
        value,
        onChange: (e: { target: { value: string } }) => onValueChange(e.target.value),
      },
      children
    ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => children,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) =>
    ReactForMock.createElement("option", { value }, children),
}))

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

  it("shows every warning the preview produced", async () => {
    // The wizard used to render a status badge and an item count next to these
    // and nothing else, so a run that skipped most of what it found reported
    // only the count it found.
    buildMigrationPreview.mockResolvedValueOnce({
      vendor: "codex",
      artifacts: {
        settings: {
          artifact: "settings",
          status: "ready",
          count: 2,
          warnings: ["model: no Cognia equivalent for `o3-high`"],
          items: [{}, {}],
        },
        sessions: { artifact: "sessions", status: "empty", count: 0, warnings: [], items: [] },
      },
    })
    const user = await openArtifacts()
    await user.click(screen.getByRole("button", { name: "Preview" }))
    await screen.findByText("2 items")

    expect(screen.getByText(/no Cognia equivalent for .o3-high/)).toBeInTheDocument()
  })

  it("shows apply-time warnings and explains a shared category", async () => {
    buildMigrationPreview.mockResolvedValueOnce({
      vendor: "codex",
      artifacts: {
        settings: {
          artifact: "settings",
          status: "ready",
          count: 2,
          warnings: [],
          items: [{}, {}],
        },
        commands: { artifact: "commands", status: "shared", count: 3, warnings: [], items: [] },
      },
    })
    applyMigration.mockResolvedValueOnce({
      vendor: "codex",
      aborted: false,
      artifacts: {
        settings: { imported: 1, warnings: ["review.md: could not parse frontmatter"] },
        commands: { imported: 0, skipped: 3, warnings: [] },
      },
    })
    const user = await openArtifacts()
    await user.click(screen.getByRole("button", { name: "Preview" }))
    await screen.findByText("2 items")
    await user.click(screen.getByRole("button", { name: "Import" }))

    expect(await screen.findByText(/could not parse frontmatter/)).toBeInTheDocument()
    // "0 imported" on its own reads like a failure. It is not: Cognia already
    // reads the same directory, so the row says so.
    expect(screen.getByTestId("result-warnings-commands")).toHaveTextContent(
      "Cognia already reads this location"
    )
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

describe("narrow-screen layout contract", () => {
  /**
   * The regression these pin.
   *
   * `components/ui/dialog.tsx` sizes itself with
   * `w-full max-w-[calc(100%-2rem)] ... sm:max-w-lg`. Passing an UNPREFIXED
   * `max-w-*` in `className` makes twMerge drop the base's
   * `max-w-[calc(100%-2rem)]`, which is the only thing giving a phone its side
   * gutter, while `sm:max-w-lg` still wins above 640px. So the override was a
   * mobile regression and a desktop no-op at the same time. Only a `sm:`
   * prefixed cap is safe.
   *
   * The body also had no scroll container, so a long list pushed the footer off
   * the screen with no way to reach it.
   *
   * jsdom does no layout, so these assert the class contract rather than
   * pixels. They are a guardrail against re-introducing the same override, not
   * proof that the dialog renders correctly.
   */
  const contentClass = () => document.querySelector("[data-slot=dialog-content]")?.className ?? ""

  async function openDialog() {
    const { AgentMigrationDialog } = await import("./agent-migration-dialog")
    const user = userEvent.setup()
    render(<AgentMigrationDialog trigger={<button>Open migration</button>} />)
    await user.click(screen.getByRole("button", { name: "Open migration" }))
    await waitFor(() => expect(probeVendors).toHaveBeenCalled())
  }

  it("caps its width only above the mobile breakpoint", async () => {
    await openDialog()
    expect(contentClass()).toMatch(/sm:max-w-/)
    expect(contentClass()).not.toMatch(/(^|\s)max-w-(?!\[)/)
  })

  it("bounds its height and lays out as a column so the body can shrink", async () => {
    await openDialog()
    expect(contentClass()).toMatch(/max-h-\[85dvh\]/)
    expect(contentClass()).toMatch(/(^|\s)flex(\s|$)/)
    expect(contentClass()).toMatch(/flex-col/)
  })

  it("puts the body in a scroll container between a pinned header and footer", async () => {
    await openDialog()
    const scroller = document.querySelector("[data-slot=scroll-area]")
    expect(scroller).not.toBeNull()
    expect(scroller?.className).toMatch(/min-h-0/)
    expect(scroller?.className).toMatch(/flex-1/)
  })
})
