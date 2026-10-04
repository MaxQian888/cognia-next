import { act, fireEvent, render, screen } from "@testing-library/react"

import type { HostFeatureManifest } from "@/lib/platform/host-feature-manifest"
import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"
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

/** Each host keeps its own credential store; the mock answers for the active one. */
const clientsByHost: Record<string, unknown[]> = {
  h1: [
    { id: "cli-1", name: "Cursor", scopes: [], createdAt: 0 },
    { id: "old", name: "Revoked", scopes: [], createdAt: 0, revokedAt: 1 },
  ],
  h2: [{ id: "cli-2", name: "Zed", scopes: [], createdAt: 0 }],
}
const mockListClients = jest.fn(async () => {
  const { useRemoteHostStore: store } = jest.requireActual("@/stores/remote-host/remote-host-store")
  return clientsByHost[store.getState().activeHostId ?? ""] ?? []
})
jest.mock("@/lib/external-bridge/tauri-control", () => ({
  listExternalBridgeClients: () => mockListClients(),
}))

/** A ready host whose manifest advertises the host-managed bridge (or not). */
function remoteHost(id: string, managed: boolean): RemoteHost {
  return {
    id,
    label: id,
    config: { baseUrl: `https://${id}.example`, serverVersion: "1.0.0" } as CompanionConfig,
    credentialRef: `remote-host:${id}`,
    addedAt: 1,
    connectionState: "ready",
    ...(managed
      ? {
          featureManifest: {
            schemaVersion: 1,
            hostBuildId: "1.0.0",
            platform: "headless",
            generatedAt: 1,
            features: {
              "external-bridge.lifecycle": { version: 1, operations: ["external_bridge_status"] },
            },
            limits: {},
          } as unknown as HostFeatureManifest,
        }
      : {}),
  }
}

const initialHostStore = useRemoteHostStore.getState()
function driveHost(activeHostId: string | null) {
  useRemoteHostStore.setState({
    hosts: [remoteHost("h1", true), remoteHost("h2", true), remoteHost("h3", false)],
    activeHostId,
  })
}
afterAll(() => useRemoteHostStore.setState(initialHostStore, true))
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
    mockListClients.mockClear()
    driveHost("h1")
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

  /**
   * The list belongs to the host being driven. It used to be fetched once on
   * mount, so after a switch the panel kept offering grants for credentials
   * the new host has never issued.
   */
  it("refetches the client list when the active host changes, with no prop change", async () => {
    await renderPanel(base())
    expect(screen.getByTestId("bridge-workspace-caller-mcp:cli-1")).toBeInTheDocument()

    await act(async () => driveHost("h2"))
    expect(screen.queryByTestId("bridge-workspace-caller-mcp:cli-1")).not.toBeInTheDocument()
    expect(screen.getByTestId("bridge-workspace-caller-mcp:cli-2")).toBeInTheDocument()
    expect(mockListClients).toHaveBeenCalledTimes(2)
  })

  it("drops host-managed clients on a host without the managed bridge, and on local", async () => {
    await renderPanel(base())
    expect(screen.getByTestId("bridge-workspace-caller-mcp:cli-1")).toBeInTheDocument()

    await act(async () => driveHost("h3"))
    expect(screen.queryByTestId("bridge-workspace-caller-mcp:cli-1")).not.toBeInTheDocument()
    expect(screen.getByTestId("bridge-workspace-caller-mcp:stdio")).toBeInTheDocument()

    await act(async () => driveHost(null))
    expect(screen.queryByTestId("bridge-workspace-caller-mcp:cli-1")).not.toBeInTheDocument()
    // Neither of those has a client store to ask.
    expect(mockListClients).toHaveBeenCalledTimes(1)
  })

  it("does not refetch on an unrelated store write", async () => {
    await renderPanel(base())
    await act(async () =>
      useRemoteHostStore.setState((state) => ({
        hosts: state.hosts.map((host) => (host.id === "h2" ? { ...host, label: "renamed" } : host)),
      }))
    )
    expect(mockListClients).toHaveBeenCalledTimes(1)
  })
})
