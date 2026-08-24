/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const listSkillsMock = jest.fn()
const listMcpServersMock = jest.fn()
jest.mock("@/lib/db/skills", () => ({ listSkills: () => listSkillsMock() }))
jest.mock("@/lib/db/mcp-servers", () => ({ listMcpServers: () => listMcpServersMock() }))

// `useClientLiveQuery` is a Dexie liveQuery wrapper; resolving the promise
// synchronously here keeps the test about the overlay rather than about Dexie.
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (query: () => unknown) => query(),
}))

import { fireEvent, render, screen } from "@testing-library/react"

import { useProjectStore } from "@/stores/project/project-store"

import { WorkspaceCapabilities } from "./workspace-capabilities"

const updateProject = jest.fn()

function seed(capabilityOverlay?: Record<string, unknown>) {
  useProjectStore.setState({
    projects: [
      {
        id: "w1",
        name: "Workspace",
        roots: [],
        ...(capabilityOverlay ? { capabilityOverlay } : {}),
      },
    ],
    updateProject,
  } as unknown as Parameters<typeof useProjectStore.setState>[0])
}

beforeEach(() => {
  updateProject.mockClear()
  listSkillsMock.mockReturnValue([
    { id: "sk-on", name: "Skill On", status: "enabled" },
    { id: "sk-off", name: "Skill Off", status: "disabled" },
  ])
  listMcpServersMock.mockReturnValue([
    { id: "mcp-1", name: "jira", transport: "http", enabled: true, trust: { state: "trusted" } },
  ])
})

it("shows each capability's effective answer, not just its own half", () => {
  seed({ skill: { "sk-on": false } })
  render(<WorkspaceCapabilities workspaceId="w1" />)

  const row = screen.getByTestId("workspace-capability-skill-sk-on")
  // Globally on, switched off here — the row must say what actually happens.
  expect(row).toHaveTextContent("effectiveOff")
  expect(row).not.toHaveTextContent("effectiveOn")
})

it("shows the global state alongside an inherited row", () => {
  seed()
  render(<WorkspaceCapabilities workspaceId="w1" />)

  expect(screen.getByTestId("workspace-capability-skill-sk-off")).toHaveTextContent("globallyOff")
  expect(screen.getByTestId("workspace-capability-skill-sk-on")).toHaveTextContent("globallyOn")
})

it("writes an override when a row is switched off", () => {
  seed()
  render(<WorkspaceCapabilities workspaceId="w1" />)

  fireEvent.click(screen.getByTestId("workspace-capability-skill-sk-on-off"))
  expect(updateProject).toHaveBeenCalledWith("w1", {
    capabilityOverlay: { skill: { "sk-on": false } },
  })
})

it("clears the override rather than storing a tombstone", () => {
  seed({ skill: { "sk-on": false } })
  render(<WorkspaceCapabilities workspaceId="w1" />)

  fireEvent.click(screen.getByTestId("workspace-capability-skill-sk-on-inherit"))
  expect(updateProject).toHaveBeenCalledWith("w1", { capabilityOverlay: {} })
})

it("keeps the other kind's overrides when writing one", () => {
  seed({ mcpServer: { "mcp-1": false } })
  render(<WorkspaceCapabilities workspaceId="w1" />)

  fireEvent.click(screen.getByTestId("workspace-capability-skill-sk-off-on"))
  expect(updateProject).toHaveBeenCalledWith("w1", {
    capabilityOverlay: { mcpServer: { "mcp-1": false }, skill: { "sk-off": true } },
  })
})

it("drops an override for a capability that no longer exists", () => {
  // A deleted skill would otherwise keep inflating the override count forever.
  seed({ skill: { "sk-on": false, "sk-deleted": true } })
  render(<WorkspaceCapabilities workspaceId="w1" />)

  fireEvent.click(screen.getByTestId("workspace-capability-skill-sk-on-inherit"))
  expect(updateProject).toHaveBeenCalledWith("w1", { capabilityOverlay: {} })
})

it("counts the overrides this workspace holds", () => {
  seed({ skill: { "sk-on": false }, mcpServer: { "mcp-1": true } })
  render(<WorkspaceCapabilities workspaceId="w1" />)

  expect(screen.getByTestId("workspace-override-count")).toHaveTextContent('"count":2')
})

it("shows no count badge when the workspace inherits everything", () => {
  seed()
  render(<WorkspaceCapabilities workspaceId="w1" />)

  expect(screen.queryByTestId("workspace-override-count")).toBeNull()
})

it("treats an untrusted server as unavailable rather than merely off", () => {
  listMcpServersMock.mockReturnValue([
    { id: "mcp-1", name: "jira", transport: "http", enabled: true, trust: { state: "pending" } },
  ])
  // The override says "on", but the trust gate is not the overlay's to open and
  // `listEnabledMcpServers` will never hand this row over. Saying "Loaded here"
  // would be this surface lying about what the agent gets.
  seed({ mcpServer: { "mcp-1": true } })
  render(<WorkspaceCapabilities workspaceId="w1" />)

  const row = screen.getByTestId("workspace-capability-mcpServer-mcp-1")
  expect(row).toHaveTextContent("effectiveOff")
  expect(row).toHaveTextContent("unavailable")
})

it("does not offer a control for a capability that cannot be switched", () => {
  listMcpServersMock.mockReturnValue([
    { id: "mcp-1", name: "jira", transport: "http", enabled: true, trust: { state: "pending" } },
  ])
  seed()
  render(<WorkspaceCapabilities workspaceId="w1" />)

  fireEvent.click(screen.getByTestId("workspace-capability-mcpServer-mcp-1-on"))
  expect(updateProject).not.toHaveBeenCalled()
})

it("still offers a control for a trusted server that is globally off", () => {
  listMcpServersMock.mockReturnValue([
    { id: "mcp-1", name: "jira", transport: "http", enabled: false, trust: { state: "trusted" } },
  ])
  seed()
  render(<WorkspaceCapabilities workspaceId="w1" />)

  fireEvent.click(screen.getByTestId("workspace-capability-mcpServer-mcp-1-on"))
  expect(updateProject).toHaveBeenCalledWith("w1", {
    capabilityOverlay: { mcpServer: { "mcp-1": true } },
  })
})

it("states that plugins are machine-wide instead of showing a dead control", () => {
  seed()
  render(<WorkspaceCapabilities workspaceId="w1" />)

  expect(screen.getByTestId("workspace-capabilities-plugins-note")).toHaveTextContent(
    "pluginsAreGlobal"
  )
  expect(screen.queryByTestId("workspace-capability-plugin-any")).toBeNull()
})

it("refuses to write while no workspace is resolved", () => {
  seed()
  render(<WorkspaceCapabilities workspaceId={null} />)

  fireEvent.click(screen.getByTestId("workspace-capability-skill-sk-on-off"))
  expect(updateProject).not.toHaveBeenCalled()
})

it("says so when a library is empty instead of rendering a blank section", () => {
  listSkillsMock.mockReturnValue([])
  seed()
  render(<WorkspaceCapabilities workspaceId="w1" />)

  expect(screen.getByTestId("workspace-skill-empty")).toHaveTextContent("noSkills")
})
