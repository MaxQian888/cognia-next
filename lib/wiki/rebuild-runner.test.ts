/**
 * @jest-environment node
 */

const readDirMock = jest.fn()
const readTextFileMock = jest.fn()
jest.mock(
  "@tauri-apps/plugin-fs",
  () => ({
    readDir: (...a: unknown[]) => readDirMock(...a),
    readTextFile: (...a: unknown[]) => readTextFileMock(...a),
  }),
  { virtual: true }
)

let platformValue: "tauri" | "headless" | "web" = "tauri"
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => platformValue,
  isTauri: () => platformValue === "tauri",
}))

const listWorkspaceDirMock = jest.fn()
const readWorkspaceFileMock = jest.fn()
jest.mock("@/lib/files/workspace-fs", () => ({
  listWorkspaceDir: (...a: unknown[]) => listWorkspaceDirMock(...a),
  readWorkspaceFile: (...a: unknown[]) => readWorkspaceFileMock(...a),
}))

const getSettingsMock = jest.fn()
jest.mock("@/lib/db/settings", () => ({ getSettings: () => getSettingsMock() }))

const createLlmClientMock = jest.fn((..._a: unknown[]) => ({ generate: jest.fn() }))
jest.mock("@/lib/twin/distill/llm", () => ({
  createLlmClient: (...a: unknown[]) => createLlmClientMock(...a),
}))

const rebuildWikiMock = jest.fn()
jest.mock("./orchestrator", () => ({
  rebuildWiki: (...a: unknown[]) => rebuildWikiMock(...a),
}))

import {
  canRunWikiRebuildOnHost,
  HostFilesystemError,
  NoApiKeyError,
  runWikiRebuild,
  WebModeError,
} from "./rebuild-runner"

type FsArg = { walk: () => Promise<string[]>; readFile: (p: string) => Promise<string> }

beforeEach(() => {
  platformValue = "tauri"
  readDirMock.mockReset()
  readTextFileMock.mockReset()
  listWorkspaceDirMock.mockReset()
  readWorkspaceFileMock.mockReset()
  getSettingsMock.mockReset().mockResolvedValue({ apiKey: "sk-test", apiProvider: "anthropic" })
  rebuildWikiMock.mockReset().mockResolvedValue({ added: 1, changed: 0, removed: 0, errors: [] })
})

describe("runWikiRebuild host neutrality", () => {
  it("exposes the host check and keeps the legacy WebModeError alias", () => {
    platformValue = "web"
    expect(canRunWikiRebuildOnHost()).toBe(false)
    platformValue = "headless"
    expect(canRunWikiRebuildOnHost()).toBe(true)
    expect(WebModeError).toBe(HostFilesystemError)
  })

  it("throws HostFilesystemError on a plain browser", async () => {
    platformValue = "web"
    await expect(runWikiRebuild()).rejects.toBeInstanceOf(HostFilesystemError)
    expect(rebuildWikiMock).not.toHaveBeenCalled()
  })

  it("walks the tree through plugin-fs on the desktop", async () => {
    readDirMock.mockImplementation(async (dir: string) => {
      if (dir === "/root") {
        return [
          { name: "docs", isDirectory: true },
          { name: "README.md", isDirectory: false },
        ]
      }
      if (dir === "/root/docs") return [{ name: "guide.md", isDirectory: false }]
      return []
    })
    readTextFileMock.mockImplementation(async (p: string) => `content of ${p}`)
    await runWikiRebuild({ rootDir: "/root", force: true })
    const [{ fs }, opts] = rebuildWikiMock.mock.calls[0] as [{ fs: FsArg }, { force?: boolean }]
    expect(await fs.walk()).toEqual(["docs/guide.md", "README.md"])
    expect(await fs.readFile("README.md")).toBe("content of /root/README.md")
    expect(opts.force).toBe(true)
  })

  it("walks the tree through the workspace-fs transport arms on the headless brain", async () => {
    platformValue = "headless"
    listWorkspaceDirMock.mockImplementation(async (root: string, rel?: string) => {
      expect(root).toBe("/srv/ws/notes")
      if (!rel) {
        return [
          { relPath: "sub", isDir: true },
          { relPath: "a.md", isDir: false },
        ]
      }
      if (rel === "sub") return [{ relPath: "sub/b.md", isDir: false }]
      return []
    })
    readWorkspaceFileMock.mockImplementation(async (_root: string, rel: string) => `# ${rel}`)
    await runWikiRebuild({ rootDir: "/srv/ws/notes" })
    const [{ fs }] = rebuildWikiMock.mock.calls[0] as [{ fs: FsArg }]
    expect(await fs.walk()).toEqual(["sub/b.md", "a.md"])
    expect(await fs.readFile("a.md")).toBe("# a.md")
    expect(readDirMock).not.toHaveBeenCalled()
  })

  it.each([
    [{ apiKey: "sk-ant-1", activeProviderId: "openai-main" }, "openai", "gpt-4o"],
    [{ apiKey: "k", activeProviderId: "google-x" }, "google", "gemini-2.5-pro"],
    [{ apiKey: "k", activeProviderId: "mistral-x" }, "mistral", "mistral-large"],
    [{ apiKey: "k", activeProviderId: "cohere-x" }, "cohere", "command-r-plus"],
    [{ apiKey: "k", activeProviderId: "custom-x" }, "anthropic", "claude-sonnet-4-6"],
    [{ apiKey: "sk-ant-1" }, "anthropic", "claude-sonnet-4-6"],
    [{ apiKey: "sk-openai" }, "openai", "gpt-4o"],
    [{ apiKey: "other" }, "anthropic", "claude-sonnet-4-6"],
  ])("derives the LLM provider/model from settings %j", async (settings, provider, model) => {
    readDirMock.mockResolvedValue([])
    getSettingsMock.mockResolvedValue(settings)
    await runWikiRebuild({ rootDir: "/root" })
    expect(createLlmClientMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider, model, apiKey: settings.apiKey })
    )
  })

  it("throws NoApiKeyError when no provider key is configured", async () => {
    readDirMock.mockResolvedValue([])
    getSettingsMock.mockResolvedValue({ apiKey: "" })
    await expect(runWikiRebuild({ rootDir: "/root" })).rejects.toBeInstanceOf(NoApiKeyError)
  })
})
