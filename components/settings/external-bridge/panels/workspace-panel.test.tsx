import { act, fireEvent, render, screen } from "@testing-library/react"

import type { ExternalBridgeSettings } from "@/types/wiki"
import { BridgeWorkspacePanel, toggleWorkspaceGrant } from "./workspace-panel"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

const projectsState = {
  projects: [
    {
      id: "p1",
      name: "App",
      roots: [
        { id: "root-a", path: "/work/app", isPrimary: true },
        { id: "root-b", path: "/work/docs", label: "Docs" },
      ],
    },
  ] as unknown[],
}
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (select: (state: typeof projectsState) => unknown) => select(projectsState),
}))

jest.mock("@/lib/external-bridge/tauri-control", () => ({
  isHostManagedBridgeAvailable: jest.fn(() => true),
  listExternalBridgeClients: jest.fn(async () => [
    { id: "cli-1", name: "Cursor", scopes: [], createdAt: 0 },
    { id: "old", name: "Revoked", scopes: [], createdAt: 0, revokedAt: 1 },
  ]),
}))
jest.mock("@/lib/db/projects", () => ({ getAllProjects: jest.fn() }))
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn() }))

function base(over: Partial<ExternalBridgeSettings> = {}): ExternalBridgeSettings {
  return { enabled: true, enabledScopes: ["workspace:read"], ...over }
}

async function renderPanel(settings: ExternalBridgeSettings) {
  const onChange = jest.fn()
  render(<BridgeWorkspacePanel settings={settings} onChange={onChange} />)
  await act(async () => undefined)
  return { onChange }
}

describe("toggleWorkspaceGrant", () => {
  it("adds and removes root ids, dropping empty callers", () => {
    const granted = toggleWorkspaceGrant(base(), "mcp:stdio", "root-a", true)
    expect(granted.workspaceGrants).toEqual({ "mcp:stdio": ["root-a"] })
    expect(toggleWorkspaceGrant(granted, "mcp:stdio", "root-a", false).workspaceGrants).toEqual({})
  })
})

describe("BridgeWorkspacePanel", () => {
  beforeEach(() => {
    projectsState.projects = [
      {
        id: "p1",
        name: "App",
        roots: [
          { id: "root-a", path: "/work/app", isPrimary: true },
          { id: "root-b", path: "/work/docs", label: "Docs" },
        ],
      },
    ]
  })

  it("lists stdio plus every live client credential, not revoked ones", async () => {
    await renderPanel(base())
    expect(screen.getByTestId("bridge-workspace-caller-mcp:stdio")).toBeInTheDocument()
    expect(screen.getByTestId("bridge-workspace-caller-mcp:cli-1")).toBeInTheDocument()
    expect(screen.queryByTestId("bridge-workspace-caller-mcp:old")).not.toBeInTheDocument()
  })

  it("grants a root to one client", async () => {
    const { onChange } = await renderPanel(base())
    fireEvent.click(screen.getByRole("switch", { name: "workspace.toggleAria:Cursor,Docs" }))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceGrants: { "mcp:cli-1": ["root-b"] } })
    )
  })

  it("shows existing grants as on and counts them", async () => {
    await renderPanel(base({ workspaceGrants: { "mcp:stdio": ["root-a"] } }))
    expect(
      screen.getByRole("switch", { name: "workspace.toggleAria:workspace.stdioClient,app" })
    ).toBeChecked()
    expect(screen.getByText("workspace.grantedCount:1")).toBeInTheDocument()
  })

  it("labels grants as inert while no workspace scope is enabled", async () => {
    await renderPanel(base({ enabledScopes: ["wiki:cognia"] }))
    expect(screen.getByTestId("bridge-workspace-scopes-off")).toBeInTheDocument()
  })

  it("explains when no workspace has a folder", async () => {
    projectsState.projects = []
    await renderPanel(base())
    expect(screen.getByTestId("bridge-workspace-no-roots")).toBeInTheDocument()
  })
})
