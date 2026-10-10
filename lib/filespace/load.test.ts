/** @jest-environment jsdom */
import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("@/lib/db/characters", () => ({ resolveCharacterById: jest.fn() }))
jest.mock("@/lib/db/sandbox-connections", () => ({ getSandboxConnection: jest.fn() }))
jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
jest.mock("@/lib/files/workspace-backend", () => ({ hasWorkspaceFsBackend: jest.fn(() => true) }))
jest.mock("./sources", () => ({ listFileSpaceDexieEntries: jest.fn() }))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: jest.fn(() => ({ projects: [] })) },
}))
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useRemoteHostStore: { getState: jest.fn(() => ({ activeHostId: null, hosts: [] })) },
}))
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: jest.fn(() => ({ settings: { sandboxTier: "os" } })) },
}))

import { resolveCharacterById } from "@/lib/db/characters"
import { getSandboxConnection } from "@/lib/db/sandbox-connections"
import { getDb } from "@/lib/db/schema"
import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { useProjectStore } from "@/stores/project/project-store"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"

import {
  currentFileSpaceHost,
  defaultLoadFileSpaceDeps,
  dockerSandboxForSession,
  loadConversationFileSpace,
  type LoadFileSpaceDeps,
} from "./load"

const session = (overrides: Partial<ChatSession> = {}) =>
  ({ id: "s1", projectId: "p1", ...overrides }) as ChatSession

function deps(overrides: Partial<LoadFileSpaceDeps> = {}): LoadFileSpaceDeps {
  return {
    getSession: jest.fn(async () => session()),
    getProject: jest.fn(async () => ({
      id: "p1",
      roots: [{ id: "root-main", path: "/repo", isPrimary: true }],
    })),
    listDexie: jest.fn(async () => ({ uploads: [], artifacts: [] })),
    dockerSandboxFor: jest.fn(async () => null),
    host: () => ({ id: "local", fsBackend: true, reachable: true }),
    ...overrides,
  }
}

describe("loadConversationFileSpace", () => {
  it("resolves the conversation from its row, workspace, Dexie mounts and host", async () => {
    const d = deps({
      listDexie: jest.fn(async () => ({
        uploads: [{ sourceId: "u1" } as never],
        artifacts: [],
      })),
    })
    const { space, dexie } = await loadConversationFileSpace("s1", d)
    expect(d.getProject).toHaveBeenCalledWith("p1")
    expect(space.mounts.map((mount) => mount.id)).toEqual(["workspace", "uploads"])
    expect(dexie.uploads).toHaveLength(1)
  })

  it("finds the workspace through the execution binding when the row names none", async () => {
    const d = deps({
      getSession: jest.fn(async () =>
        session({
          projectId: undefined,
          executionContext: {
            location: "local",
            workspaceBinding: { kind: "project", projectId: "p9" },
            projectId: "p9",
            projectRoot: "",
            taskWorkspace: { taskId: "t", workspaceKey: "s1" },
          },
        })
      ),
    })
    await loadConversationFileSpace("s1", d)
    expect(d.getProject).toHaveBeenCalledWith("p9")
  })

  it("is deleted, reading nothing else, when the session is gone", async () => {
    const d = deps({ getSession: jest.fn(async () => undefined) })
    const { space } = await loadConversationFileSpace("s1", d)
    expect(space.status).toBe("deleted")
    expect(d.listDexie).not.toHaveBeenCalled()
    expect(d.getProject).not.toHaveBeenCalled()
  })
})

describe("defaultLoadFileSpaceDeps.getProject", () => {
  it("prefers the loaded store, then the Dexie row a cold start has not hydrated yet", async () => {
    ;(useProjectStore.getState as jest.Mock).mockReturnValueOnce({
      projects: [{ id: "p1", roots: [] }],
    })
    await expect(defaultLoadFileSpaceDeps.getProject("p1")).resolves.toEqual({
      id: "p1",
      roots: [],
    })

    const get = jest.fn(async () => ({ id: "p2", roots: [] }))
    ;(getDb as jest.Mock).mockReturnValue({ projects: { get } })
    await expect(defaultLoadFileSpaceDeps.getProject("p2")).resolves.toEqual({
      id: "p2",
      roots: [],
    })
    expect(get).toHaveBeenCalledWith("p2")

    get.mockResolvedValueOnce(undefined as never)
    await expect(defaultLoadFileSpaceDeps.getProject("p3")).resolves.toBeNull()
  })
})

describe("currentFileSpaceHost", () => {
  it("is this machine when no remote host is driven", () => {
    ;(hasWorkspaceFsBackend as jest.Mock).mockReturnValueOnce(false)
    expect(currentFileSpaceHost()).toEqual({ id: "local", fsBackend: false, reachable: true })
  })

  it("is the driven host, reachable only while its connection is up", () => {
    const host = (connectionState: string) => ({
      activeHostId: "h1",
      hosts: [{ id: "h1", label: "build box", connectionState }],
    })
    ;(useRemoteHostStore.getState as jest.Mock).mockReturnValueOnce(host("ready"))
    expect(currentFileSpaceHost()).toEqual({
      id: "h1",
      label: "build box",
      fsBackend: true,
      reachable: true,
    })
    ;(useRemoteHostStore.getState as jest.Mock).mockReturnValueOnce(host("degraded"))
    expect(currentFileSpaceHost().reachable).toBe(true)
    ;(useRemoteHostStore.getState as jest.Mock).mockReturnValueOnce(host("disconnected"))
    expect(currentFileSpaceHost().reachable).toBe(false)
  })
})

describe("dockerSandboxForSession", () => {
  it("follows session, then character, then settings to a Docker connection", async () => {
    ;(resolveCharacterById as jest.Mock).mockResolvedValue({
      computerUseTarget: { connectionId: "conn-1" },
    })
    ;(getSandboxConnection as jest.Mock).mockResolvedValue({
      config: {
        provider: "docker",
        image: "node",
        workspaceMount: { hostPath: "/repo", containerPath: "/w" },
      },
    })
    await expect(dockerSandboxForSession(session({ characterId: "c1" }))).resolves.toMatchObject({
      workspaceMount: { hostPath: "/repo", containerPath: "/w" },
    })
    expect(resolveCharacterById).toHaveBeenCalledWith("c1")
    expect(getSandboxConnection).toHaveBeenCalledWith("conn-1")
  })

  it("is null for a local target or a non-Docker connection", async () => {
    ;(resolveCharacterById as jest.Mock).mockResolvedValue(undefined)
    await expect(dockerSandboxForSession(session())).resolves.toBeNull()

    ;(getSandboxConnection as jest.Mock).mockResolvedValue({
      config: { provider: "lume", vmName: "v" },
    })
    await expect(
      dockerSandboxForSession(session({ computerUseTarget: { connectionId: "c" } }))
    ).resolves.toBeNull()
  })
})
