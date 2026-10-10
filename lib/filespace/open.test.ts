/** @jest-environment jsdom */
jest.mock("@/lib/artifacts/reveal", () => ({
  revealArtifactInWorkspace: jest.fn(),
  revealSessionPanel: jest.fn(),
}))
jest.mock("@/lib/files/workspace-fs", () => ({ statWorkspaceFile: jest.fn() }))
jest.mock("./load", () => ({ loadConversationFileSpace: jest.fn() }))

import { revealArtifactInWorkspace, revealSessionPanel } from "@/lib/artifacts/reveal"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useChatStore } from "@/stores/chat"
import { useFileSpacePanelStore } from "@/stores/filespace/filespace-panel-store"
import type {
  ConversationFileSpace,
  FileSpaceDexieEntry,
  FileSpaceMount,
  FileSpacePath,
} from "@/types/filespace"

import type { LoadedConversationFileSpace } from "./load"
import { defaultOpenFileSpaceDeps, openFileSpacePath, type OpenFileSpaceDeps } from "./open"

const p = (value: string) => value as FileSpacePath

const WORKSPACE: FileSpaceMount = {
  id: "workspace",
  virtualPath: "/workspace",
  backing: "disk",
  label: "app",
  hostPath: "/repo",
  managed: false,
  role: "primary",
  writable: true,
  status: "available",
}
const DOCS: FileSpaceMount = {
  ...WORKSPACE,
  id: "root:docs",
  virtualPath: "/roots/docs",
  hostPath: "/docs",
  role: "additional",
}
const UPLOADS: FileSpaceMount = {
  id: "uploads",
  virtualPath: "/uploads",
  backing: "dexie",
  label: "uploads",
  managed: false,
  writable: false,
  status: "available",
}
const ARTIFACTS: FileSpaceMount = {
  ...UPLOADS,
  id: "artifacts",
  virtualPath: "/artifacts",
  label: "artifacts",
}

function entry(
  mountId: "uploads" | "artifacts",
  name: string,
  sourceId: string
): FileSpaceDexieEntry {
  return {
    mountId,
    path: p(`/${mountId}/${name}`),
    name,
    size: 1,
    mediaType: "text/plain",
    createdAt: 1,
    updatedAt: 1,
    sourceId,
    sourceAvailable: true,
  }
}

function loaded(
  mounts: FileSpaceMount[],
  status: ConversationFileSpace["status"] = "available"
): LoadedConversationFileSpace {
  return {
    space: { sessionId: "s1", hostId: "local", status, mounts },
    dexie: {
      uploads: [entry("uploads", "report.pdf", "asset-1")],
      artifacts: [entry("artifacts", "Util.ts", "art-1")],
    },
  }
}

function deps(overrides: Partial<OpenFileSpaceDeps> = {}): OpenFileSpaceDeps & {
  [K in keyof OpenFileSpaceDeps]: OpenFileSpaceDeps[K]
} {
  return {
    load: jest.fn(async () => loaded([WORKSPACE, DOCS, UPLOADS, ARTIFACTS])),
    stat: jest.fn(async () => ({ exists: true, isDir: false, size: 1, mtimeMs: 1 })),
    activeSessionId: () => "s1",
    revealFilesPanel: jest.fn(),
    revealFile: jest.fn(),
    revealRoot: jest.fn(),
    revealArtifact: jest.fn(() => true),
    ...overrides,
  }
}

describe("openFileSpacePath", () => {
  it("opens a file in the editor rooted at its own mount", async () => {
    const d = deps()
    await expect(
      openFileSpacePath({ sessionId: "s1", path: p("/roots/docs/guide/a.md"), line: 4 }, d)
    ).resolves.toBe("opened")
    expect(d.stat).toHaveBeenCalledWith("/docs", "guide/a.md")
    expect(d.revealFile).toHaveBeenCalledWith({
      sessionId: "s1",
      rootPath: "/docs",
      relPath: "guide/a.md",
      line: 4,
    })
  })

  it("roots the editor at the mount for the mount itself or a directory in it", async () => {
    const d = deps({
      stat: jest.fn(async () => ({ exists: true, isDir: true, size: 0, mtimeMs: 1 })),
    })
    await openFileSpacePath({ sessionId: "s1", path: p("/workspace") }, d)
    await openFileSpacePath({ sessionId: "s1", path: p("/workspace/src") }, d)
    expect(d.revealRoot).toHaveBeenNthCalledWith(1, { sessionId: "s1", rootPath: "/repo" })
    expect(d.revealRoot).toHaveBeenNthCalledWith(2, { sessionId: "s1", rootPath: "/repo" })
    expect(d.stat).toHaveBeenCalledTimes(1)
    expect(d.revealFile).not.toHaveBeenCalled()
  })

  it("brings the Files panel forward for the bare view, an upload or a Dexie mount", async () => {
    const d = deps()
    await openFileSpacePath({ sessionId: "s1" }, d)
    await openFileSpacePath({ sessionId: "s1", path: p("/uploads/report.pdf") }, d)
    await openFileSpacePath({ sessionId: "s1", path: p("/uploads") }, d)
    expect(d.revealFilesPanel).toHaveBeenNthCalledWith(1, "s1")
    expect(d.revealFilesPanel).toHaveBeenNthCalledWith(2, "s1", "/uploads/report.pdf")
    expect(d.revealFilesPanel).toHaveBeenNthCalledWith(3, "s1", "/uploads")
    expect(d.load).toHaveBeenCalledTimes(2)
  })

  it("opens an artifact in the artifact surface, falling back to the panel", async () => {
    const d = deps()
    await expect(
      openFileSpacePath({ sessionId: "s1", path: p("/artifacts/Util.ts") }, d)
    ).resolves.toBe("opened")
    expect(d.revealArtifact).toHaveBeenCalledWith("art-1")
    expect(d.revealFilesPanel).not.toHaveBeenCalled()

    const notLoaded = deps({ revealArtifact: jest.fn(() => false) })
    await openFileSpacePath({ sessionId: "s1", path: p("/artifacts/Util.ts") }, notLoaded)
    expect(notLoaded.revealFilesPanel).toHaveBeenCalledWith("s1", "/artifacts/Util.ts")
  })

  it("reports each way a path cannot be shown", async () => {
    expect(await openFileSpacePath({ sessionId: "s1", path: p("/elsewhere/x") }, deps())).toBe(
      "outside"
    )
    expect(await openFileSpacePath({ sessionId: "s1", path: p("/uploads/none.pdf") }, deps())).toBe(
      "not-found"
    )
    expect(
      await openFileSpacePath(
        { sessionId: "s1", path: p("/workspace/x") },
        deps({
          stat: jest.fn(async () => ({ exists: false, isDir: false, size: 0, mtimeMs: null })),
        })
      )
    ).toBe("not-found")
    expect(
      await openFileSpacePath(
        { sessionId: "s1", path: p("/workspace/x") },
        deps({ stat: jest.fn(async () => Promise.reject(new Error("outside roots"))) })
      )
    ).toBe("not-found")
    expect(
      await openFileSpacePath(
        { sessionId: "s1", path: p("/workspace/x") },
        deps({ load: jest.fn(async () => loaded([], "deleted")) })
      )
    ).toBe("not-found")
    expect(
      await openFileSpacePath(
        { sessionId: "s1", path: p("/workspace/x") },
        deps({
          load: jest.fn(async () =>
            loaded([
              { ...WORKSPACE, status: "offline", statusReason: "no-fs-backend", writable: false },
            ])
          ),
        })
      )
    ).toBe("no-backend")
    expect(
      await openFileSpacePath(
        { sessionId: "s1", path: p("/workspace/x") },
        deps({
          load: jest.fn(async () =>
            loaded([
              { ...WORKSPACE, status: "offline", statusReason: "host-offline", writable: false },
            ])
          ),
        })
      )
    ).toBe("offline")
  })

  it("does nothing for a conversation the user is no longer looking at", async () => {
    let active = "s1"
    const d = deps({
      activeSessionId: () => active,
      stat: jest.fn(async () => {
        active = "s2"
        return { exists: true, isDir: false, size: 1, mtimeMs: 1 }
      }),
    })
    await expect(
      openFileSpacePath({ sessionId: "s1", path: p("/workspace/a.ts") }, d)
    ).resolves.toBe("session-changed")
    expect(d.revealFile).not.toHaveBeenCalled()
    await expect(openFileSpacePath({ sessionId: "s3" }, d)).resolves.toBe("session-changed")
    expect(d.revealFilesPanel).not.toHaveBeenCalled()
  })
})

describe("defaultOpenFileSpaceDeps", () => {
  it("reveals through the dock, the Files panel focus and the artifact surface", () => {
    useChatStore.setState({ activeSessionId: "s1" })
    expect(defaultOpenFileSpaceDeps.activeSessionId()).toBe("s1")

    defaultOpenFileSpaceDeps.revealFilesPanel("s1", p("/uploads/a.pdf"))
    expect(useFileSpacePanelStore.getState().focus).toMatchObject({
      sessionId: "s1",
      path: "/uploads/a.pdf",
    })
    expect(revealSessionPanel).toHaveBeenCalledWith("s1", "conversation-files", "narrow")

    defaultOpenFileSpaceDeps.revealRoot({ sessionId: "s1", rootPath: "/docs" })
    expect(useArtifactDockLayoutStore.getState().workspaceContext).toEqual({
      kind: "root",
      sessionId: "s1",
      rootPath: "/docs",
    })
    defaultOpenFileSpaceDeps.revealFile({ sessionId: "s1", rootPath: "/repo", relPath: "a.ts" })
    expect(useArtifactDockLayoutStore.getState().workspaceRevealRequest).toMatchObject({
      kind: "file",
      relPath: "a.ts",
    })

    ;(revealArtifactInWorkspace as jest.Mock).mockReturnValueOnce(null)
    expect(defaultOpenFileSpaceDeps.revealArtifact("missing")).toBe(false)
  })
})
