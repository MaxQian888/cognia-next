const call = jest.fn()
jest.mock("@/lib/tauri", () => ({
  transport: { call: (...a: unknown[]) => call(...a) },
}))

const detectPlatform = jest.fn(() => "tauri")
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => detectPlatform(),
}))

const isRemoteHostActive = jest.fn(() => false)
jest.mock("@/lib/tauri/transport-routing", () => ({
  isRemoteHostActive: () => isRemoteHostActive(),
}))

import { canWalkWorkspace, walkWorkspaceTree } from "./workspace-walk"

const entry = (relPath: string, isDir = false) => ({
  rel_path: relPath,
  absolute_path: `/ws/${relPath}`,
  is_dir: isDir,
  size: 4,
  mtime_ms: 1,
})

function routeCalls(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  call.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    const handler = handlers[command]
    if (!handler) throw new Error(`unexpected command: ${command}`)
    return handler(args)
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  detectPlatform.mockReturnValue("tauri")
  isRemoteHostActive.mockReturnValue(false)
})

describe("canWalkWorkspace", () => {
  it("is true only on a local desktop", () => {
    expect(canWalkWorkspace()).toBe(true)
    isRemoteHostActive.mockReturnValue(true)
    expect(canWalkWorkspace()).toBe(false)
    isRemoteHostActive.mockReturnValue(false)
    detectPlatform.mockReturnValue("web")
    expect(canWalkWorkspace()).toBe(false)
  })
})

describe("walkWorkspaceTree", () => {
  it("uses the native walk on a local desktop", async () => {
    routeCalls({
      fs_walk_workspace: () => ({
        entries: [entry("a.txt")],
        truncated: false,
        skippedSensitive: 2,
      }),
    })
    const walk = await walkWorkspaceTree("/ws", { relPath: "src", sensitiveFloor: true })
    expect(call).toHaveBeenCalledWith(
      "fs_walk_workspace",
      expect.objectContaining({ relPath: "src" })
    )
    expect(call.mock.calls[0][1]).not.toHaveProperty("sensitiveFloor")
    expect(walk).toMatchObject({ degraded: false, skippedSensitive: 2, truncated: false })
    expect(walk.entries.map((e) => e.relPath)).toEqual(["a.txt"])
  })

  it("degrades to breadth-first depth-1 listings elsewhere", async () => {
    detectPlatform.mockReturnValue("web")
    routeCalls({
      fs_list_workspace_dir: ({ relPath, includeIgnored }) => {
        expect(includeIgnored).toBe(false)
        if (relPath === undefined) return [entry("src", true), entry("a.txt")]
        if (relPath === "src") return [entry("src/b.txt"), entry("src/deep", true)]
        return [entry("src/deep/c.txt")]
      },
    })
    const walk = await walkWorkspaceTree("/ws", { includeIgnored: false })
    expect(walk.degraded).toBe(true)
    expect(walk.entries.map((e) => e.relPath)).toEqual(["a.txt", "src/b.txt", "src/deep/c.txt"])
    expect(walk.skippedSensitive).toBe(0)
  })

  it("applies the sensitive floor to a degraded walk only when asked", async () => {
    detectPlatform.mockReturnValue("headless")
    const tree = ({ relPath }: Record<string, unknown>) => {
      if (relPath === undefined) {
        return [entry(".ssh", true), entry(".config", true), entry(".env"), entry("ok.txt")]
      }
      if (relPath === ".config") return [entry(".config/gh", true), entry(".config/nvim", true)]
      if (relPath === ".ssh") return [entry(".ssh/id_rsa")]
      if (relPath === ".config/gh") return [entry(".config/gh/hosts.yml")]
      return [entry(".config/nvim/init.lua")]
    }
    routeCalls({ fs_list_workspace_dir: tree })
    const floored = await walkWorkspaceTree("/ws", { sensitiveFloor: true })
    expect(floored.entries.map((e) => e.relPath)).toEqual(["ok.txt", ".config/nvim/init.lua"])
    expect(floored.skippedSensitive).toBe(3)

    const raw = await walkWorkspaceTree("/ws")
    expect(raw.entries.map((e) => e.relPath)).toContain(".env")
    expect(raw.skippedSensitive).toBe(0)
  })

  it("reports truncation at the entry and depth caps", async () => {
    detectPlatform.mockReturnValue("web")
    routeCalls({
      fs_list_workspace_dir: ({ relPath }) =>
        relPath === undefined
          ? [entry("a"), entry("b"), entry("c"), entry("d", true)]
          : [entry("d/e")],
    })
    expect(await walkWorkspaceTree("/ws", { maxEntries: 2 })).toMatchObject({
      truncated: true,
      entries: [expect.anything(), expect.anything()],
    })
    const shallow = await walkWorkspaceTree("/ws", { maxDepth: 1 })
    expect(shallow.truncated).toBe(true)
    expect(shallow.entries.map((e) => e.relPath)).toEqual(["a", "b", "c"])
  })
})
