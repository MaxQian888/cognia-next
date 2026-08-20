/**
 * @jest-environment jsdom
 */

import { spawnDefaultTerminal } from "./spawn-default"
import { spawnFromDock } from "./spawn-orchestrator"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"

jest.mock("./spawn-orchestrator", () => ({
  spawnFromDock: jest.fn(async () => ({
    kind: "spawned" as const,
    sessionId: "s-new",
    shell: "/bin/bash",
  })),
}))

jest.mock("./shell-detect", () => ({
  resolveDefaultShell: ({
    projectShell,
    settingShell,
    hostDefaultShell,
  }: {
    projectShell?: string
    settingShell?: string
    hostDefaultShell?: string
  }) => projectShell ?? settingShell ?? hostDefaultShell ?? "/platform/default",
}))

let mockHostCapabilities: { defaultShell: string } | null = null
const mockEnsureHostCapabilities = jest.fn(async () => mockHostCapabilities)

jest.mock("./host-capabilities", () => ({
  ensureHostCapabilities: () => mockEnsureHostCapabilities(),
}))

const mockedSpawn = spawnFromDock as jest.MockedFunction<typeof spawnFromDock>

function withSettings(terminal: Record<string, unknown>) {
  useSettingsStore.setState({ settings: { terminal } } as never)
}

function lastRequest() {
  return mockedSpawn.mock.calls.at(-1)![0].req
}

beforeEach(() => {
  mockedSpawn.mockClear()
  mockEnsureHostCapabilities.mockClear()
  mockHostCapabilities = null
  useProjectStore.setState({ projects: [], activeProjectId: null } as never)
  withSettings({})
})

describe("spawnDefaultTerminal", () => {
  it("falls back to the platform default with no project or settings", async () => {
    await spawnDefaultTerminal()
    expect(lastRequest()).toMatchObject({
      shell: "/platform/default",
      rows: 24,
      cols: 80,
      enableShellIntegration: true,
      forceUtf8: true,
      sandboxed: false,
    })
  })

  it("prefers the user's configured default shell over the platform one", async () => {
    withSettings({ defaultShell: "/usr/bin/fish" })
    await spawnDefaultTerminal()
    expect(lastRequest().shell).toBe("/usr/bin/fish")
  })

  it("prefers the project's shell over the user setting", async () => {
    withSettings({ defaultShell: "/usr/bin/fish" })
    const project = useProjectStore.getState().createProject({ name: "p", rootDir: "/repo" })
    useProjectStore.getState().updateProject(project.id, {
      terminalConfig: { shell: "/bin/zsh", cwd: "  /work  ", env: { A: "1" } },
    })
    useProjectStore.getState().setActiveProject(project.id)

    await spawnDefaultTerminal()
    expect(lastRequest()).toMatchObject({
      shell: "/bin/zsh",
      cwd: "/work",
      env: { A: "1" },
      projectId: project.id,
    })
  })

  it("falls back to the project root when terminalConfig.cwd is unset", async () => {
    const project = useProjectStore.getState().createProject({ name: "p", rootDir: "/repo" })
    useProjectStore.getState().setActiveProject(project.id)
    await spawnDefaultTerminal()
    expect(lastRequest().cwd).toBe("/repo")
  })

  it("lets a durable child worktree override project and profile cwd", async () => {
    const project = useProjectStore.getState().createProject({ name: "p", rootDir: "/repo" })
    useProjectStore.getState().setActiveProject(project.id)
    withSettings({
      defaultProfileId: "p1",
      profiles: [{ id: "p1", name: "Shell", shell: "/bin/zsh", cwd: "/profile" }],
    })

    await spawnDefaultTerminal({ cwdOverride: " /repo/.worktrees/child-1 " })

    expect(lastRequest().cwd).toBe("/repo/.worktrees/child-1")
  })

  it("an explicit shell override beats everything", async () => {
    withSettings({ defaultShell: "/usr/bin/fish", defaultProfileId: "p1" })
    await spawnDefaultTerminal({ shellOverride: "/bin/dash" })
    expect(lastRequest().shell).toBe("/bin/dash")
  })

  // Over ws/webrtc the platform fallback describes the CLIENT: a macOS browser
  // paired to a Linux cognia-server used to ask it for /bin/zsh and get a
  // failed spawn with no explanation.
  it("prefers what the host reported over the platform fallback", async () => {
    mockHostCapabilities = { defaultShell: "/bin/ash" }
    await spawnDefaultTerminal()
    expect(lastRequest().shell).toBe("/bin/ash")
  })

  // A user who typed a shell path meant it, on whichever machine.
  it("keeps the user setting above the host default", async () => {
    mockHostCapabilities = { defaultShell: "/bin/ash" }
    withSettings({ defaultShell: "/usr/bin/fish" })
    await spawnDefaultTerminal()
    expect(lastRequest().shell).toBe("/usr/bin/fish")
  })

  it("does not probe the host when the caller already named a shell", async () => {
    await spawnDefaultTerminal({ shellOverride: "/bin/dash" })
    expect(mockEnsureHostCapabilities).not.toHaveBeenCalled()
  })

  it("launches the configured default profile when there is one", async () => {
    withSettings({
      defaultProfileId: "p1",
      profiles: [{ id: "p1", name: "Fish", shell: "/usr/bin/fish", args: ["-l"] }],
    })
    await spawnDefaultTerminal()
    expect(lastRequest()).toMatchObject({
      shell: "/usr/bin/fish",
      args: ["-l"],
      profileId: "p1",
    })
  })

  it("launches an explicitly named profile", async () => {
    withSettings({
      profiles: [{ id: "p2", name: "Dash", shell: "/bin/dash" }],
    })
    await spawnDefaultTerminal({ profileId: "p2" })
    expect(lastRequest()).toMatchObject({ shell: "/bin/dash", profileId: "p2" })
  })

  it("falls back to the resolved shell when the profile is missing or blank", async () => {
    withSettings({
      defaultShell: "/usr/bin/fish",
      defaultProfileId: "gone",
      profiles: [{ id: "blank", name: "Blank", shell: "   " }],
    })
    await spawnDefaultTerminal()
    expect(lastRequest().shell).toBe("/usr/bin/fish")
    expect(lastRequest().profileId).toBeUndefined()

    await spawnDefaultTerminal({ profileId: "blank" })
    expect(lastRequest().shell).toBe("/usr/bin/fish")
  })

  it("passes forceUtf8 and sandboxed through from settings", async () => {
    withSettings({ forceUtf8: false, sandboxed: true })
    await spawnDefaultTerminal()
    expect(lastRequest()).toMatchObject({ forceUtf8: false, sandboxed: true })
  })

  it("honours an explicit null projectId for a project-less tab", async () => {
    const project = useProjectStore.getState().createProject({ name: "p", rootDir: "/repo" })
    useProjectStore.getState().setActiveProject(project.id)
    await spawnDefaultTerminal({ projectId: null })
    expect(lastRequest().projectId).toBeUndefined()
    expect(lastRequest().cwd).toBeUndefined()
  })

  it("accepts explicit rows and cols", async () => {
    await spawnDefaultTerminal({ rows: 40, cols: 120 })
    expect(lastRequest()).toMatchObject({ rows: 40, cols: 120 })
  })

  it("returns the orchestrator's outcome unchanged", async () => {
    mockedSpawn.mockResolvedValueOnce({ kind: "denied" })
    await expect(spawnDefaultTerminal()).resolves.toEqual({ kind: "denied" })
  })
})
