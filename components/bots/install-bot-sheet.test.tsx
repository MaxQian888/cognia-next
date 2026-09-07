/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { BotCatalogEntry } from "@/lib/bot/console/catalog"
import type { InstallBotFromCatalogInput } from "@/lib/bot/control-writes"

const install = jest.fn(async (_input: InstallBotFromCatalogInput) => "boti_new")
let readiness = { availability: { state: "available", reason: "local-host" }, can: true }
let catalog: { entries: BotCatalogEntry[]; loading: boolean } = { entries: [], loading: false }
let activeProjectId: string | null = null

jest.mock("@/hooks/bots/use-bot-lifecycle-actions", () => ({
  useBotLifecycleReadiness: () => readiness,
  useBotLifecycleActions: () => ({
    pending: new Set<string>(),
    install: (input: InstallBotFromCatalogInput) => install(input),
  }),
}))
jest.mock("@/hooks/bots/use-bot-catalog", () => ({
  useBotCatalog: () => catalog,
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (state: { activeProjectId: string | null }) => unknown) =>
    selector({ activeProjectId }),
}))

import { InstallBotSheet } from "./install-bot-sheet"

function entry(over: Partial<BotCatalogEntry> = {}): BotCatalogEntry {
  return {
    definitionId: "acme:digest",
    source: "plugin",
    name: "Daily digest",
    description: "Summarises the day",
    version: "1.2.0",
    executor: "workflow",
    triggers: [{ id: "cron", kind: "schedule", cron: "0 9 * * *" }],
    slots: [],
    requiredSlots: [],
    pluginId: "acme",
    installedCount: 0,
    unresolvedHandler: false,
    ...over,
  }
}

beforeEach(() => {
  install.mockClear().mockResolvedValue("boti_new")
  readiness = { availability: { state: "available", reason: "local-host" }, can: true }
  catalog = { entries: [entry()], loading: false }
  activeProjectId = null
})

describe("InstallBotSheet", () => {
  it("lists a definition with the facts a choice needs", () => {
    render(<InstallBotSheet open onOpenChange={jest.fn()} />)
    const row = screen.getByTestId("bot-catalog-acme:digest")
    expect(row).toHaveTextContent("Daily digest")
    expect(row).toHaveTextContent("1.2.0")
    expect(row).toHaveTextContent("1 trigger")
  })

  it("installs at account scope and hands the new id back", async () => {
    const user = userEvent.setup()
    const onInstalled = jest.fn()
    const onOpenChange = jest.fn()
    render(<InstallBotSheet open onOpenChange={onOpenChange} onInstalled={onInstalled} />)
    await user.click(screen.getByTestId("bot-install-acme:digest"))
    expect(install).toHaveBeenCalledWith({
      entry: entry(),
      scope: { kind: "account" },
    })
    expect(onInstalled).toHaveBeenCalledWith("boti_new")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("stays open when the install fails, so the toast has context", async () => {
    install.mockResolvedValue(undefined as unknown as string)
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    render(<InstallBotSheet open onOpenChange={onOpenChange} />)
    await user.click(screen.getByTestId("bot-install-acme:digest"))
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("counts existing installations without removing the row", () => {
    // Installing a second copy is a real thing to want.
    catalog = { entries: [entry({ installedCount: 2 })], loading: false }
    render(<InstallBotSheet open onOpenChange={jest.fn()} />)
    expect(screen.getByTestId("bot-catalog-acme:digest")).toHaveTextContent("2 installed")
    expect(screen.getByTestId("bot-install-acme:digest")).toBeEnabled()
  })

  it("refuses a definition whose handler never loaded, and says which one", () => {
    catalog = { entries: [entry({ executor: "handler", unresolvedHandler: true })], loading: false }
    render(<InstallBotSheet open onOpenChange={jest.fn()} />)
    expect(screen.getByTestId("bot-install-acme:digest")).toBeDisabled()
    expect(screen.getByTestId("bot-catalog-blocked-acme:digest")).toHaveTextContent(
      "handler did not load"
    )
  })

  it("refuses a workspace scope while no workspace is open, and says so", async () => {
    const user = userEvent.setup()
    render(<InstallBotSheet open onOpenChange={jest.fn()} />)
    await user.click(screen.getByLabelText("Install for"))
    await user.click(await screen.findByRole("option", { name: "Workspace" }))
    expect(screen.getByTestId("bot-install-scope-hint")).toHaveTextContent("No workspace is open")
    expect(screen.getByTestId("bot-install-acme:digest")).toBeDisabled()
  })

  it("installs at workspace scope once a workspace is open", async () => {
    activeProjectId = "prj_1"
    const user = userEvent.setup()
    render(<InstallBotSheet open onOpenChange={jest.fn()} />)
    await user.click(screen.getByLabelText("Install for"))
    await user.click(await screen.findByRole("option", { name: "Workspace" }))
    await user.click(screen.getByTestId("bot-install-acme:digest"))
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: "workspace", workspaceId: "prj_1" } })
    )
  })

  it("renders the project scope and disables it, rather than dropping the option", async () => {
    // The kind exists for a Bot bound to one project inside a workspace, and
    // this console has no project picker. An absent option and an unusable one
    // are different answers.
    const user = userEvent.setup()
    render(<InstallBotSheet open onOpenChange={jest.fn()} />)
    await user.click(screen.getByLabelText("Install for"))
    expect(await screen.findByRole("option", { name: "Project" })).toHaveAttribute(
      "aria-disabled",
      "true"
    )
  })

  it("filters by search and says the list is filtered rather than empty", async () => {
    const user = userEvent.setup()
    render(<InstallBotSheet open onOpenChange={jest.fn()} />)
    await user.type(screen.getByTestId("bot-catalog-search"), "telegram")
    expect(screen.getByText("No definition matches that search.")).toBeInTheDocument()
  })

  it("tells nothing-installed apart from nothing-matching", () => {
    catalog = { entries: [], loading: false }
    render(<InstallBotSheet open onOpenChange={jest.fn()} />)
    expect(
      screen.getByText("No plugin on this device contributes a Bot, and you have not written one.")
    ).toBeInTheDocument()
  })

  it("disables every install with the reason when the shell cannot write", () => {
    readiness = {
      availability: { state: "unsupported", reason: "requires-companion" },
      can: false,
    }
    render(<InstallBotSheet open onOpenChange={jest.fn()} />)
    expect(screen.getByTestId("bot-install-acme:digest")).toBeDisabled()
    expect(screen.getByTestId("bot-install-blocked")).toHaveTextContent(
      "This browser cannot run Bots"
    )
  })
})
