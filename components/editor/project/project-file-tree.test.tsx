/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { readdir, stat } from "node:fs/promises"
import path from "node:path"

let mockDesktop = true
let mockRemoteActive = false
const mockTransportListeners = new Set<() => void>()
const mockRemoteListeners = new Set<() => void>()
jest.mock("@/lib/platform/detect", () => ({ isTauri: () => mockDesktop }))
jest.mock("@/lib/tauri/transport-instance", () => ({
  onTransportChange: (listener: () => void) => {
    mockTransportListeners.add(listener)
    return () => mockTransportListeners.delete(listener)
  },
}))
jest.mock("@/lib/tauri/transport-routing", () => ({
  isRemoteHostActive: () => mockRemoteActive,
  subscribeActiveRemoteTransport: (listener: () => void) => {
    mockRemoteListeners.add(listener)
    return () => mockRemoteListeners.delete(listener)
  },
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function mockIconThemeSubscribers(): Array<() => void> {
  const state = globalThis as typeof globalThis & {
    __projectIconThemeSubscribers?: Array<() => void>
  }
  return (state.__projectIconThemeSubscribers ??= [])
}
let mockActiveIconTheme: {
  id: string
  baseDir: string
  jsonPath: string
} | null = null
const mockResolveFileIcon = jest.fn((_id: string, _filename: string) => ({
  iconPath: "icons/typescript.svg",
}))
const mockConvertFileSrc = jest.fn((path: string) => `asset://${path}`)

jest.mock("@/lib/plugin/bridge/icons-bridge", () => ({
  getActiveIconTheme: () => mockActiveIconTheme,
  resolveFileIcon: (id: string, filename: string) => mockResolveFileIcon(id, filename),
  subscribeIconThemes: (callback: () => void) => {
    mockIconThemeSubscribers().push(callback)
    return jest.fn()
  },
}))

jest.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => mockConvertFileSrc(path),
}))

// Flatten Radix ContextMenu: trigger renders its child; content + items render
// inline so tests can click them without a real pointer-driven menu.
jest.mock("@/components/ui/context-menu", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  return {
    ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    ContextMenuItem: ({
      children,
      onSelect,
    }: {
      children: React.ReactNode
      onSelect?: () => void
    }) => (
      <button type="button" onClick={onSelect}>
        {children}
      </button>
    ),
    ContextMenuSeparator: () => null,
    // Submenus flatten inline so template entries stay clickable in tests.
    ContextMenuSub: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    ContextMenuSubTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    ContextMenuSubContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  }
})

// Flatten AlertDialog to render children when open.
jest.mock("@/components/ui/alert-dialog", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  return {
    AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
      open ? <div role="alertdialog">{children}</div> : null,
    AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
    AlertDialogAction: ({
      children,
      onClick,
    }: {
      children: React.ReactNode
      onClick?: () => void
    }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
  }
})

import { ProjectFileTree, type ProjectFileTreeDeps } from "./project-file-tree"
import type { WorkspaceEntry } from "@/lib/files/types"

function entry(relPath: string, isDir: boolean): WorkspaceEntry {
  return { relPath, absolutePath: `/repo/${relPath}`, isDir, size: 0, mtimeMs: null }
}

function makeDeps(): ProjectFileTreeDeps & { fs: Record<string, WorkspaceEntry[]> } {
  const fs: Record<string, WorkspaceEntry[]> = {
    "": [entry("src", true), entry("readme.md", false)],
    src: [entry("src/a.ts", false)],
  }
  return {
    fs,
    listDir: jest.fn(async (_root: string, rel?: string) => fs[rel ?? ""] ?? []),
    createDir: jest.fn(async () => {}),
    writeFile: jest.fn(async () => {}),
    deleteEntry: jest.fn(async () => {}),
    renameEntry: jest.fn(async () => {}),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("listing lifecycle", () => {
  it("bounds listing traffic for a real project directory during ten invalidations", async () => {
    const rootPath = __dirname
    const entries = await Promise.all(
      (await readdir(rootPath, { withFileTypes: true })).map(async (item) => {
        const absolutePath = path.join(rootPath, item.name)
        const metadata = await stat(absolutePath)
        return {
          relPath: item.name,
          absolutePath,
          isDir: item.isDirectory(),
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
        }
      })
    )
    const deps = makeDeps()
    const pending = deferred<void>()
    let inFlight = 0
    let peakInFlight = 0
    let calls = 0
    let listingBytes = 0
    deps.listDir = jest.fn(async () => {
      calls += 1
      const first = calls === 1
      inFlight += 1
      peakInFlight = Math.max(peakInFlight, inFlight)
      if (first) await pending.promise
      listingBytes += Buffer.byteLength(JSON.stringify(entries), "utf8")
      inFlight -= 1
      return entries
    })
    const props = { rootPath, activePath: null, onOpenFile: jest.fn(), deps }
    const { rerender } = render(<ProjectFileTree {...props} refreshToken={0} />)
    for (let token = 1; token <= 10; token++)
      rerender(<ProjectFileTree {...props} refreshToken={token} />)
    await act(async () => pending.resolve())
    console.info(
      "tree-real-directory-burst",
      JSON.stringify({ entries: entries.length, calls, peakInFlight, listingBytes })
    )
    expect(calls).toBe(2)
    expect(peakInFlight).toBe(1)
    expect(screen.getByTestId("tree-row-project-file-tree.tsx")).toBeInTheDocument()
  })

  it("coalesces ten refresh invalidations during a pending list into one fresh trailing read", async () => {
    const deps = makeDeps()
    const pending = deferred<WorkspaceEntry[]>()
    const listDir = jest
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue([entry("fresh.md", false)])
    deps.listDir = listDir
    const props = { rootPath: "/repo", activePath: null, onOpenFile: jest.fn(), deps }
    const { rerender } = render(<ProjectFileTree {...props} refreshToken={0} />)
    for (let token = 1; token <= 10; token++)
      rerender(<ProjectFileTree {...props} refreshToken={token} />)
    const callsWhilePending = listDir.mock.calls.length
    await act(async () => pending.resolve([entry("stale.md", false)]))
    console.info(
      "tree-refresh-burst",
      JSON.stringify({ callsWhilePending, totalCalls: listDir.mock.calls.length })
    )
    expect(callsWhilePending).toBe(1)
    expect(listDir).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId("tree-row-fresh.md")).toBeInTheDocument()
    expect(screen.queryByTestId("tree-row-stale.md")).toBeNull()
  })

  it.each(["success", "failure"])("ignores a previous root's late %s", async (outcome) => {
    const deps = makeDeps()
    const pending = deferred<WorkspaceEntry[]>()
    deps.listDir = jest
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue([entry("new.md", false)])
    const onFailure = jest.fn()
    const props = { activePath: null, onOpenFile: jest.fn(), deps, onFailure }
    const { rerender } = render(<ProjectFileTree {...props} rootPath="/old" />)
    rerender(<ProjectFileTree {...props} rootPath="/new" />)
    await screen.findByTestId("tree-row-new.md")
    await act(async () => {
      if (outcome === "success") pending.resolve([entry("old.md", false)])
      else pending.reject(new Error("host is offline"))
    })
    expect(screen.getByTestId("tree-row-new.md")).toBeInTheDocument()
    expect(screen.queryByTestId("tree-row-old.md")).toBeNull()
    expect(onFailure).not.toHaveBeenCalled()
  })

  it("keeps expanded directories when deps and failure callbacks change identity", async () => {
    const deps = makeDeps()
    const props = { rootPath: "/repo", activePath: null, onOpenFile: jest.fn() }
    const { rerender } = render(<ProjectFileTree {...props} deps={deps} onFailure={jest.fn()} />)
    fireEvent.click(await screen.findByTestId("tree-row-src"))
    await screen.findByTestId("tree-row-src/a.ts")
    const before = (deps.listDir as jest.Mock).mock.calls.length
    rerender(<ProjectFileTree {...props} deps={{ ...deps }} onFailure={jest.fn()} />)
    await act(async () => {})
    expect(screen.getByTestId("tree-row-src/a.ts")).toBeInTheDocument()
    expect(deps.listDir).toHaveBeenCalledTimes(before)
  })

  it.each(["success", "failure"])(
    "ignores a previous root's late create %s without closing the new root's input",
    async (outcome) => {
      const deps = makeDeps()
      const pending = deferred<void>()
      deps.writeFile = jest.fn(() => pending.promise)
      const onOpenFile = jest.fn()
      const onFailure = jest.fn()
      const props = { activePath: null, onOpenFile, onFailure, deps }
      const { rerender } = render(<ProjectFileTree {...props} rootPath="/old" />)
      await screen.findByTestId("tree-row-readme.md")
      fireEvent.click(screen.getByLabelText("newFile"))
      fireEvent.change(screen.getByPlaceholderText("newFile"), { target: { value: "old.txt" } })
      fireEvent.keyDown(screen.getByPlaceholderText("newFile"), { key: "Enter" })
      rerender(<ProjectFileTree {...props} rootPath="/new" />)
      await screen.findByTestId("tree-row-readme.md")
      fireEvent.click(screen.getByLabelText("newFile"))
      fireEvent.change(screen.getByPlaceholderText("newFile"), { target: { value: "new.txt" } })
      await act(async () => {
        if (outcome === "success") pending.resolve()
        else pending.reject(new Error("offline"))
      })
      expect(screen.getByPlaceholderText("newFile")).toHaveValue("new.txt")
      expect(onOpenFile).not.toHaveBeenCalled()
      expect(onFailure).not.toHaveBeenCalled()
    }
  )

  it.each([mockTransportListeners, mockRemoteListeners])(
    "invalidates pending reads when the transport target changes",
    async (listeners) => {
      const deps = makeDeps()
      const pending = deferred<WorkspaceEntry[]>()
      deps.listDir = jest
        .fn()
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValue([entry("new-host.md", false)])
      render(
        <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
      )
      await act(async () => {
        listeners.forEach((listener) => listener())
        pending.resolve([entry("old-host.md", false)])
      })
      expect(await screen.findByTestId("tree-row-new-host.md")).toBeInTheDocument()
      expect(screen.queryByTestId("tree-row-old-host.md")).toBeNull()
    }
  )

  it.each(["rename", "delete", "move"])(
    "ignores old-root %s completion after switching roots",
    async (operation) => {
      const deps = makeDeps()
      const pending = deferred<void>()
      deps.renameEntry = jest.fn(() => pending.promise)
      deps.deleteEntry = jest.fn(() => pending.promise)
      const onRenamed = jest.fn()
      const props = { activePath: null, onOpenFile: jest.fn(), onRenamed, deps }
      const { rerender } = render(<ProjectFileTree {...props} rootPath="/old" />)
      await screen.findByTestId("tree-row-readme.md")
      if (operation === "rename") {
        fireEvent.click(screen.getAllByText("rename")[1])
        fireEvent.change(screen.getByLabelText("rename"), { target: { value: "renamed.md" } })
        fireEvent.keyDown(screen.getByLabelText("rename"), { key: "Enter" })
      } else if (operation === "delete") {
        fireEvent.click(screen.getAllByText("delete")[1])
        fireEvent.click(
          within(screen.getByRole("alertdialog")).getByRole("button", { name: "delete" })
        )
      } else {
        fireEvent.drop(screen.getByTestId("tree-row-src"), {
          dataTransfer: { types: ["application/x-cognia-tree-row"], getData: () => "readme.md" },
        })
      }
      rerender(<ProjectFileTree {...props} rootPath="/new" />)
      await screen.findByTestId("tree-row-readme.md")
      const calls = (deps.listDir as jest.Mock).mock.calls.length
      await act(async () => pending.resolve())
      expect(onRenamed).not.toHaveBeenCalled()
      expect(deps.listDir).toHaveBeenCalledTimes(calls)
      expect(screen.queryByTestId("tree-row-src/a.ts")).toBeNull()
    }
  )

  it("does not report a pending failure after unmount and removes transport subscriptions", async () => {
    const deps = makeDeps()
    const pending = deferred<WorkspaceEntry[]>()
    deps.listDir = jest.fn(() => pending.promise)
    const onFailure = jest.fn()
    const { unmount } = render(
      <ProjectFileTree
        rootPath="/repo"
        activePath={null}
        onOpenFile={jest.fn()}
        deps={deps}
        onFailure={onFailure}
      />
    )
    unmount()
    await act(async () => pending.reject(new Error("offline")))
    expect(onFailure).not.toHaveBeenCalled()
    expect(mockTransportListeners.size).toBe(0)
    expect(mockRemoteListeners.size).toBe(0)
  })
})

describe("remote tree freshness", () => {
  let visibility: DocumentVisibilityState
  beforeEach(() => {
    jest.useFakeTimers()
    mockDesktop = false
    visibility = "visible"
    jest.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility)
  })
  afterEach(() => {
    mockDesktop = true
    mockRemoteActive = false
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  async function tick(ms = 5_000) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms)
    })
  }

  it.each(["browser", "desktop-remote"])(
    "refreshes expanded directories on %s and stops for hidden, collapsed, and unmounted trees",
    async (mode) => {
      mockDesktop = mode === "desktop-remote"
      mockRemoteActive = mode === "desktop-remote"
      const deps = makeDeps()
      const { unmount } = render(
        <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
      )
      await act(async () => {})
      fireEvent.click(screen.getByTestId("tree-row-src"))
      await act(async () => {})
      deps.fs.src = [entry("src/remote.ts", false)]
      await tick()
      expect(screen.getByTestId("tree-row-src/remote.ts")).toBeInTheDocument()
      expect(screen.queryByTestId("tree-row-src/a.ts")).toBeNull()
      const beforeHidden = (deps.listDir as jest.Mock).mock.calls.length
      visibility = "hidden"
      fireEvent(document, new Event("visibilitychange"))
      await tick(30_000)
      expect(deps.listDir).toHaveBeenCalledTimes(beforeHidden)
      visibility = "visible"
      await act(async () => {
        fireEvent(document, new Event("visibilitychange"))
      })
      expect(deps.listDir).toHaveBeenCalledTimes(beforeHidden + 2)
      fireEvent.click(screen.getByTestId("tree-row-src"))
      await tick()
      expect(deps.listDir).toHaveBeenCalledTimes(beforeHidden + 3)
      unmount()
      await tick(30_000)
      expect(deps.listDir).toHaveBeenCalledTimes(beforeHidden + 3)
    }
  )

  it("retains expansion without polling or token refresh while inactive and refreshes on activation", async () => {
    const deps = makeDeps()
    const props = { rootPath: "/repo", activePath: null, onOpenFile: jest.fn(), deps }
    const { rerender } = render(<ProjectFileTree {...props} active refreshToken={0} />)
    await act(async () => {})
    fireEvent.click(screen.getByTestId("tree-row-src"))
    await act(async () => {})
    expect(deps.listDir).toHaveBeenCalledTimes(2)
    rerender(<ProjectFileTree {...props} active={false} refreshToken={1} />)
    await tick(30_000)
    expect(deps.listDir).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId("tree-row-src")).toHaveAttribute("aria-expanded", "true")
    deps.fs.src = [entry("src/refreshed.ts", false)]
    rerender(<ProjectFileTree {...props} active refreshToken={1} />)
    await act(async () => {})
    expect(deps.listDir).toHaveBeenCalledTimes(4)
    expect(screen.getByTestId("tree-row-src/refreshed.ts")).toBeInTheDocument()
  })

  it("closes a portaled delete confirmation when its retained panel becomes inactive", async () => {
    const deps = makeDeps()
    const props = { rootPath: "/repo", activePath: null, onOpenFile: jest.fn(), deps }
    const { rerender } = render(<ProjectFileTree {...props} active />)
    await act(async () => {})
    fireEvent.click(screen.getAllByText("delete")[1])
    expect(screen.getByRole("alertdialog")).toBeInTheDocument()
    rerender(<ProjectFileTree {...props} active={false} />)
    expect(screen.queryByRole("alertdialog")).toBeNull()
    rerender(<ProjectFileTree {...props} active />)
    await act(async () => {})
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(deps.deleteEntry).not.toHaveBeenCalled()
  })

  it("defers the initial root read while inactive and starts with the latest root and host", async () => {
    const deps = makeDeps()
    const props = { activePath: null, onOpenFile: jest.fn(), deps }
    const { rerender } = render(<ProjectFileTree {...props} rootPath="/old" active={false} />)
    rerender(<ProjectFileTree {...props} rootPath="/new" active={false} />)
    act(() => {
      for (const listener of mockTransportListeners) listener()
    })
    await tick(30_000)
    expect(deps.listDir).not.toHaveBeenCalled()
    rerender(<ProjectFileTree {...props} rootPath="/new" active />)
    await act(async () => {})
    expect(deps.listDir).toHaveBeenCalledTimes(1)
    expect(deps.listDir).toHaveBeenCalledWith("/new", undefined)
  })

  it("does not duplicate the fresh root read when changing root and activating together", async () => {
    const deps = makeDeps()
    const pending = deferred<WorkspaceEntry[]>()
    const listDir = deps.listDir as jest.Mock
    listDir.mockImplementationOnce(() => pending.promise)
    const props = { activePath: null, onOpenFile: jest.fn(), deps }
    const { rerender } = render(<ProjectFileTree {...props} rootPath="/old" active={false} />)
    rerender(<ProjectFileTree {...props} rootPath="/new" active />)
    await act(async () => {
      pending.resolve(deps.fs[""])
    })
    expect(listDir).toHaveBeenCalledTimes(1)
    expect(listDir).toHaveBeenCalledWith("/new", undefined)
  })

  it("discards an in-flight listing while inactive then refreshes on return", async () => {
    const deps = makeDeps()
    const pending = deferred<WorkspaceEntry[]>()
    const listDir = deps.listDir as jest.Mock
    listDir.mockImplementationOnce(() => pending.promise)
    const props = { rootPath: "/repo", activePath: null, onOpenFile: jest.fn(), deps }
    const { rerender } = render(<ProjectFileTree {...props} active />)
    rerender(<ProjectFileTree {...props} active={false} />)
    await act(async () => {
      pending.resolve([entry("stale.ts", false)])
    })
    expect(screen.queryByTestId("tree-row-stale.ts")).toBeNull()
    await tick(30_000)
    expect(listDir).toHaveBeenCalledTimes(1)
    rerender(<ProjectFileTree {...props} active />)
    await act(async () => {})
    expect(listDir).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId("tree-row-src")).toBeInTheDocument()
  })

  it("coalesces repeated reactivation behind a pending directory read", async () => {
    const pending = deferred<WorkspaceEntry[]>()
    const deps = makeDeps()
    const listDir = deps.listDir as jest.Mock
    listDir.mockImplementationOnce(() => pending.promise)
    const props = { rootPath: "/repo", activePath: null, onOpenFile: jest.fn(), deps }
    const { rerender } = render(<ProjectFileTree {...props} active />)
    rerender(<ProjectFileTree {...props} active={false} />)
    rerender(<ProjectFileTree {...props} active />)
    rerender(<ProjectFileTree {...props} active={false} />)
    rerender(<ProjectFileTree {...props} active />)
    expect(listDir).toHaveBeenCalledTimes(1)
    await act(async () => {
      pending.resolve([entry("stale.ts", false)])
    })
    expect(listDir).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId("tree-row-stale.ts")).toBeNull()
    expect(screen.getByTestId("tree-row-src")).toBeInTheDocument()
  })

  it("does not poll local desktop directories", async () => {
    mockDesktop = true
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await tick(30_000)
    expect(deps.listDir).toHaveBeenCalledTimes(1)
  })

  it("pauses offline polling and resumes immediately online without overlapping reads", async () => {
    let online = false
    jest.spyOn(navigator, "onLine", "get").mockImplementation(() => online)
    const deps = makeDeps()
    const pending = deferred<WorkspaceEntry[]>()
    const listDir = deps.listDir as jest.Mock
    listDir
      .mockImplementationOnce(async () => deps.fs[""])
      .mockImplementationOnce(() => pending.promise)
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await tick(30_000)
    expect(listDir).toHaveBeenCalledTimes(1)
    online = true
    fireEvent(window, new Event("online"))
    fireEvent(window, new Event("online"))
    await tick(30_000)
    expect(listDir).toHaveBeenCalledTimes(2)
    await act(async () => pending.resolve([entry("online.md", false)]))
    expect(screen.getByTestId("tree-row-online.md")).toBeInTheDocument()
    online = false
    fireEvent(window, new Event("offline"))
    await tick(30_000)
    expect(listDir).toHaveBeenCalledTimes(2)
  })

  it("does not fetch collapsed descendants or directories collapsed during a slow poll", async () => {
    const deps = makeDeps()
    deps.fs.src = [entry("src/deep", true)]
    deps.fs["src/deep"] = [entry("src/deep/a.ts", false)]
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await act(async () => {})
    fireEvent.click(screen.getByTestId("tree-row-src"))
    await act(async () => {})
    fireEvent.click(screen.getByTestId("tree-row-src/deep"))
    await act(async () => {})
    const pending = deferred<WorkspaceEntry[]>()
    const listDir = deps.listDir as jest.Mock
    listDir.mockImplementationOnce(() => pending.promise)
    await tick()
    const before = listDir.mock.calls.length
    fireEvent.click(screen.getByTestId("tree-row-src"))
    await act(async () => pending.resolve(deps.fs[""]))
    expect(listDir).toHaveBeenCalledTimes(before)
    await tick()
    expect(listDir).toHaveBeenCalledTimes(before + 1)
  })

  it("waits for slow reads, recovers after failures, and avoids repeated failure notifications", async () => {
    const deps = makeDeps()
    const pending = deferred<WorkspaceEntry[]>()
    const listDir = jest
      .fn()
      .mockResolvedValueOnce(deps.fs[""])
      .mockImplementationOnce(() => pending.promise)
      .mockRejectedValue(new Error("host is offline"))
    deps.listDir = listDir
    const onFailure = jest.fn()
    render(
      <ProjectFileTree
        rootPath="/repo"
        activePath={null}
        onOpenFile={jest.fn()}
        deps={deps}
        onFailure={onFailure}
      />
    )
    await tick()
    await tick(30_000)
    expect(listDir).toHaveBeenCalledTimes(2)
    await act(async () => pending.reject(new Error("host is offline")))
    expect(screen.getByTestId("file-tree-failure-root")).toBeInTheDocument()
    await tick(10_000)
    expect(onFailure).toHaveBeenCalledTimes(1)
    listDir.mockResolvedValue([entry("reconnected.md", false)])
    await tick()
    expect(screen.queryByTestId("file-tree-failure-root")).toBeNull()
    expect(screen.getByTestId("tree-row-reconnected.md")).toBeInTheDocument()
  })
})

describe("ProjectFileTree", () => {
  it("refreshes expanded children through the toolbar and root menu", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    fireEvent.click(await screen.findByTestId("tree-row-src"))
    await screen.findByTestId("tree-row-src/a.ts")
    deps.fs.src = [entry("src/toolbar.ts", false)]
    fireEvent.click(screen.getByLabelText("refresh"))
    await screen.findByTestId("tree-row-src/toolbar.ts")
    deps.fs.src = [entry("src/menu.ts", false)]
    fireEvent.click(screen.getByText("refresh"))
    await screen.findByTestId("tree-row-src/menu.ts")
  })

  it("copies relative and absolute paths through existing callbacks", async () => {
    const onCopyPath = jest.fn()
    render(
      <ProjectFileTree
        rootPath="/repo"
        activePath="readme.md"
        onOpenFile={jest.fn()}
        deps={makeDeps()}
        onCopyPath={onCopyPath}
      />
    )
    await screen.findByTestId("tree-row-readme.md")
    fireEvent.click(screen.getAllByText("action.copyRelativePath")[1])
    expect(onCopyPath).toHaveBeenLastCalledWith("readme.md", false)
    fireEvent.click(screen.getAllByText("action.copyPath")[1])
    expect(onCopyPath).toHaveBeenLastCalledWith("readme.md", true)
  })

  it("supports root context creation and cancellation inside a directory template", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await screen.findByTestId("tree-row-src")
    fireEvent.click(screen.getAllByText("newFile").at(-1)!)
    fireEvent.keyDown(screen.getByPlaceholderText("newFile"), { key: "Escape" })
    fireEvent.click(screen.getAllByText("newFolder").at(-1)!)
    fireEvent.change(screen.getByPlaceholderText("newFolder"), { target: { value: "new-dir" } })
    fireEvent.blur(screen.getByPlaceholderText("newFolder"))
    await waitFor(() => expect(deps.createDir).toHaveBeenCalledWith("/repo", "new-dir"))
    fireEvent.click(screen.getAllByText("templates.markdown")[0])
    expect(screen.getByPlaceholderText("templates.markdown")).toHaveValue("README.md")
    fireEvent.keyDown(screen.getByPlaceholderText("templates.markdown"), { key: "Escape" })
    expect(screen.queryByPlaceholderText("templates.markdown")).toBeNull()
    expect(deps.writeFile).not.toHaveBeenCalled()
  })

  it("highlights and clears root and directory drop targets without accepting external drags", async () => {
    render(
      <ProjectFileTree
        rootPath="/repo"
        activePath={null}
        onOpenFile={jest.fn()}
        deps={makeDeps()}
      />
    )
    const row = await screen.findByTestId("tree-row-src")
    const root = screen.getByTestId("project-file-tree-scroll")
    const dataTransfer = {
      types: ["application/x-cognia-tree-row"],
      dropEffect: "",
      getData: () => "",
    }
    fireEvent.dragOver(root, { dataTransfer })
    expect(root).toHaveClass("bg-accent/30")
    fireEvent.dragLeave(root)
    expect(root).not.toHaveClass("bg-accent/30")
    fireEvent.dragOver(row, { dataTransfer })
    expect(row).toHaveClass("bg-primary/15")
    fireEvent.dragLeave(row)
    expect(row).not.toHaveClass("bg-primary/15")
    fireEvent.dragOver(root, { dataTransfer: { ...dataTransfer, types: ["Files"] } })
    fireEvent.dragOver(row, { dataTransfer: { ...dataTransfer, types: ["Files"] } })
    expect(root).not.toHaveClass("bg-accent/30")
    expect(row).not.toHaveClass("bg-primary/15")
    fireEvent.drop(root, { dataTransfer })
    fireEvent.drop(row, { dataTransfer })
  })

  it("uses touch-sized rows and toolbar actions in touch density", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree
        rootPath="/repo"
        activePath={null}
        onOpenFile={jest.fn()}
        deps={deps}
        density="touch"
      />
    )

    await waitFor(() => expect(screen.getByTestId("tree-row-readme.md")).toHaveClass("min-h-11"))
    expect(screen.getByLabelText("newFile")).toHaveClass("size-11")
  })

  it("lazily lists the root and opens a file on click", async () => {
    const deps = makeDeps()
    const onOpenFile = jest.fn()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={onOpenFile} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-readme.md")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("tree-row-readme.md"))
    expect(onOpenFile).toHaveBeenCalledWith("readme.md", { mode: "preview" })
  })

  it("double-clicking a file asks for a pinned tab", async () => {
    const deps = makeDeps()
    const onOpenFile = jest.fn()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={onOpenFile} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-readme.md")).toBeInTheDocument())
    fireEvent.doubleClick(screen.getByTestId("tree-row-readme.md"))
    expect(onOpenFile).toHaveBeenLastCalledWith("readme.md", { mode: "pinned" })
  })

  it("double-clicking a directory toggles it instead of opening a tab", async () => {
    const deps = makeDeps()
    const onOpenFile = jest.fn()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={onOpenFile} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    fireEvent.doubleClick(screen.getByTestId("tree-row-src"))
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it("expands a directory to lazily load its children", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("tree-row-src"))
    await waitFor(() => expect(screen.getByTestId("tree-row-src/a.ts")).toBeInTheDocument())
    expect(deps.listDir).toHaveBeenCalledWith("/repo", "src")
  })

  it("creates a new file from the toolbar and opens it", async () => {
    const deps = makeDeps()
    const onOpenFile = jest.fn()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={onOpenFile} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText("newFile"))
    const input = await screen.findByPlaceholderText("newFile")
    fireEvent.change(input, { target: { value: "new.ts" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(deps.writeFile).toHaveBeenCalledWith("/repo", "new.ts", ""))
    expect(onOpenFile).toHaveBeenCalledWith("new.ts")
  })

  it("creates a new folder from the toolbar", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText("newFolder"))
    const input = await screen.findByPlaceholderText("newFolder")
    fireEvent.change(input, { target: { value: "lib" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(deps.createDir).toHaveBeenCalledWith("/repo", "lib"))
  })

  it("renames an entry via its context menu", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-readme.md")).toBeInTheDocument())
    // The flattened context menu renders a "rename" button per row.
    fireEvent.click(screen.getAllByText("rename")[1]) // readme.md's rename (src has one too)
    const input = await screen.findByLabelText("rename")
    fireEvent.click(input)
    fireEvent.change(input, { target: { value: "README2.md" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(deps.renameEntry).toHaveBeenCalledWith("/repo", "readme.md", "README2.md")
    )
  })

  it("deletes an entry through the confirm dialog", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-readme.md")).toBeInTheDocument())
    fireEvent.click(screen.getAllByText("delete")[1])
    const dialog = await screen.findByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "delete" }))
    await waitFor(() => expect(deps.deleteEntry).toHaveBeenCalledWith("/repo", "readme.md", false))
  })

  it("shows the empty state only after the root listing succeeds", async () => {
    const deps = makeDeps()
    ;(deps.listDir as jest.Mock).mockResolvedValue([])
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    // Until the listing resolves the tree is loading, not empty — the "No
    // files" claim must wait for a real answer.
    expect(screen.getByTestId("tree-loading")).toBeInTheDocument()
    expect(screen.queryByText("treeEmpty")).toBeNull()
    await waitFor(() => expect(screen.getByText("treeEmpty")).toBeInTheDocument())
    expect(screen.queryByTestId("tree-loading")).toBeNull()
  })

  it("offers a new-file action inside the empty state", async () => {
    const deps = makeDeps()
    ;(deps.listDir as jest.Mock).mockResolvedValue([])
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    fireEvent.click(await screen.findByTestId("tree-empty-new-file"))
    expect(await screen.findByPlaceholderText("newFile")).toBeInTheDocument()
  })

  it("cancels a create on Escape and ignores an empty name", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText("newFile"))
    const input = await screen.findByPlaceholderText("newFile")
    // Empty name + blur → no write.
    fireEvent.blur(input)
    expect(deps.writeFile).not.toHaveBeenCalled()
    // Reopen and cancel with Escape.
    fireEvent.click(screen.getByLabelText("newFile"))
    const input2 = await screen.findByPlaceholderText("newFile")
    fireEvent.keyDown(input2, { key: "Escape" })
    expect(screen.queryByPlaceholderText("newFile")).toBeNull()
  })

  it("cancels a rename on Escape without renaming", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-readme.md")).toBeInTheDocument())
    fireEvent.click(screen.getAllByText("rename")[1])
    const input = await screen.findByLabelText("rename")
    fireEvent.keyDown(input, { key: "Escape" })
    expect(deps.renameEntry).not.toHaveBeenCalled()
  })

  it("creates a file inside a directory via its context menu", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    // The src row's context menu offers New File / New Folder.
    fireEvent.click(screen.getAllByText("newFile")[0]) // first match is src's menu item
    const input = await screen.findByPlaceholderText("newFile")
    fireEvent.change(input, { target: { value: "child.ts" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(deps.writeFile).toHaveBeenCalledWith("/repo", "src/child.ts", ""))
  })

  it("creates a folder inside a directory via its context menu", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    fireEvent.click(screen.getAllByText("newFolder")[0]) // src's context menu New Folder
    const input = await screen.findByPlaceholderText("newFolder")
    fireEvent.change(input, { target: { value: "sub" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(deps.createDir).toHaveBeenCalledWith("/repo", "src/sub"))
  })

  it("closes the confirm dialog after a delete fails", async () => {
    const deps = makeDeps()
    ;(deps.deleteEntry as jest.Mock).mockRejectedValue(new Error("EPERM"))
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-readme.md")).toBeInTheDocument())
    fireEvent.click(screen.getAllByText("delete")[1])
    const dialog = await screen.findByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "delete" }))
    await waitFor(() => expect(deps.deleteEntry).toHaveBeenCalled())
    // Tree still rendered (no crash).
    expect(screen.getByTestId("project-file-tree")).toBeInTheDocument()
  })

  it("collapses an expanded directory on a second click", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("tree-row-src"))
    await waitFor(() => expect(screen.getByTestId("tree-row-src/a.ts")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("tree-row-src"))
    await waitFor(() => expect(screen.queryByTestId("tree-row-src/a.ts")).toBeNull())
  })

  it("reloads expanded dirs when refreshToken bumps", async () => {
    const deps = makeDeps()
    const { rerender } = render(
      <ProjectFileTree
        rootPath="/repo"
        refreshToken={0}
        activePath={null}
        onOpenFile={jest.fn()}
        deps={deps}
      />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    const before = (deps.listDir as jest.Mock).mock.calls.length
    rerender(
      <ProjectFileTree
        rootPath="/repo"
        refreshToken={1}
        activePath={null}
        onOpenFile={jest.fn()}
        deps={deps}
      />
    )
    await waitFor(() =>
      expect((deps.listDir as jest.Mock).mock.calls.length).toBeGreaterThan(before)
    )

    const beforeManualRefresh = (deps.listDir as jest.Mock).mock.calls.length
    fireEvent.click(screen.getByLabelText("refresh"))
    await waitFor(() =>
      expect((deps.listDir as jest.Mock).mock.calls.length).toBeGreaterThan(beforeManualRefresh)
    )
  })

  it("uses a contributed file icon and reacts to icon theme changes", async () => {
    mockActiveIconTheme = {
      id: "theme",
      baseDir: "/plugins/theme",
      jsonPath: "icons/theme.json",
    }
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )

    await waitFor(() => expect(document.querySelector("img")).not.toBeNull())
    const icon = document.querySelector("img")
    expect(icon).toHaveAttribute("src", "asset:///plugins/theme/icons/icons/typescript.svg")
    expect(mockResolveFileIcon).toHaveBeenCalledWith("theme", "readme.md")

    act(() => mockIconThemeSubscribers().forEach((notify) => notify()))
    expect(mockConvertFileSrc).toHaveBeenCalled()
    mockActiveIconTheme = null
  })
  it("swallows a create error without leaving the inline input stuck", async () => {
    const deps = makeDeps()
    ;(deps.writeFile as jest.Mock).mockRejectedValue(new Error("EACCES"))
    const onOpenFile = jest.fn()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={onOpenFile} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText("newFile"))
    const input = await screen.findByPlaceholderText("newFile")
    fireEvent.change(input, { target: { value: "new.ts" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(screen.queryByPlaceholderText("newFile")).toBeNull())
    expect(onOpenFile).not.toHaveBeenCalled()
    expect(screen.getByTestId("project-file-tree")).toBeInTheDocument()
  })

  /**
   * Retitled. This used to assert the swallow itself, which is the behaviour
   * that made a remote backend unusable. What it should pin is the part that
   * was always right: a failed rename must not strand the row in edit mode.
   * That the failure is now reported is pinned in "failures reach the user".
   */
  it("leaves no row in edit mode after a rename fails", async () => {
    const deps = makeDeps()
    ;(deps.renameEntry as jest.Mock).mockRejectedValue(new Error("EPERM"))
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-readme.md")).toBeInTheDocument())
    fireEvent.click(screen.getAllByText("rename")[1])
    const input = await screen.findByLabelText("rename")
    fireEvent.change(input, { target: { value: "README2.md" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(screen.queryByLabelText("rename")).toBeNull())
    expect(screen.getByTestId("project-file-tree")).toBeInTheDocument()
  })
})

/**
 * Every one of these failed silently before. The listing path was the worst:
 * it wrote an empty array, so a directory the caller may not read rendered
 * identically to one that genuinely has nothing in it.
 */
describe("failures reach the user", () => {
  function renderTree(deps: ProjectFileTreeDeps, onFailure = jest.fn()) {
    render(
      <ProjectFileTree
        rootPath="/repo"
        activePath={null}
        onOpenFile={jest.fn()}
        deps={deps}
        onFailure={onFailure}
      />
    )
    return onFailure
  }

  it("shows why a directory could not be read, instead of calling it empty", async () => {
    const deps = makeDeps()
    deps.listDir = jest.fn(async () => {
      throw new Error("EACCES: permission denied")
    })
    const onFailure = renderTree(deps)

    const row = await screen.findByTestId("file-tree-failure-root")
    expect(row).toHaveAttribute("data-failure", "denied")
    expect(row.textContent).toContain("treeFailure.denied")
    expect(screen.queryByText("treeEmpty")).toBeNull()
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ kind: "denied" }), "list", "")
  })

  /**
   * Retry is offered only for the one kind that could succeed unchanged.
   * A permission denial with a retry button trains people to click it.
   */
  it("offers a retry for an unreachable host and not for a denial", async () => {
    const unreachable = makeDeps()
    unreachable.listDir = jest.fn(async () => {
      throw new Error("host is offline")
    })
    const { unmount } = render(
      <ProjectFileTree
        rootPath="/repo"
        activePath={null}
        onOpenFile={jest.fn()}
        deps={unreachable}
      />
    )
    const first = await screen.findByTestId("file-tree-failure-root")
    expect(within(first).queryByLabelText("refresh")).not.toBeNull()
    unmount()

    const denied = makeDeps()
    denied.listDir = jest.fn(async () => {
      throw new Error("EACCES: permission denied")
    })
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={denied} />
    )
    const second = await screen.findByTestId("file-tree-failure-root")
    expect(within(second).queryByLabelText("refresh")).toBeNull()
  })

  it("clears the failure once the directory reads", async () => {
    const deps = makeDeps()
    let fail = true
    const listDir = jest.fn(async (_root: string, rel?: string) => {
      if (fail) throw new Error("host is offline")
      return deps.fs[rel ?? ""] ?? []
    })
    deps.listDir = listDir as unknown as ProjectFileTreeDeps["listDir"]
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    const row = await screen.findByTestId("file-tree-failure-root")
    fail = false
    fireEvent.click(within(row).getByLabelText("refresh"))

    await waitFor(() => expect(screen.queryByTestId("file-tree-failure-root")).toBeNull())
    expect(await screen.findByTestId("tree-row-readme.md")).toBeInTheDocument()
  })

  it("reports a failed delete rather than closing the dialog as if it worked", async () => {
    const deps = makeDeps()
    deps.deleteEntry = jest.fn(async () => {
      throw new Error("EROFS: read-only file system")
    })
    const onFailure = renderTree(deps)

    await screen.findByTestId("tree-row-readme.md")
    fireEvent.click(screen.getAllByText("delete")[1])
    const dialog = await screen.findByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "delete" }))

    await waitFor(() =>
      expect(onFailure).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "denied" }),
        "delete",
        "readme.md"
      )
    )
  })

  it("reports a failed rename", async () => {
    const deps = makeDeps()
    deps.renameEntry = jest.fn(async () => {
      throw new Error("EEXIST: file already exists")
    })
    const onFailure = renderTree(deps)

    await screen.findByTestId("tree-row-readme.md")
    fireEvent.click(screen.getAllByText("rename")[1])
    const input = await screen.findByLabelText("rename")
    fireEvent.change(input, { target: { value: "taken.md" } })
    fireEvent.keyDown(input, { key: "Enter" })

    await waitFor(() =>
      expect(onFailure).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "conflict" }),
        "rename",
        "readme.md"
      )
    )
  })
})

describe("git decorations", () => {
  it("badges a file row with its status letter", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree
        rootPath="/repo"
        activePath={null}
        onOpenFile={jest.fn()}
        deps={deps}
        gitDecorations={new Map([["readme.md", "modified"]])}
      />
    )
    await waitFor(() => expect(screen.getByTestId("tree-git-readme.md")).toHaveTextContent("M"))
  })

  it("aggregates the worst descendant status onto a collapsed directory", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree
        rootPath="/repo"
        activePath={null}
        onOpenFile={jest.fn()}
        deps={deps}
        gitDecorations={
          new Map([
            ["src/a.ts", "untracked"],
            ["src/deep/b.ts", "conflicted"],
          ])
        }
      />
    )
    // src never has to be expanded: the badge rolls up from the flat map.
    await waitFor(() => expect(screen.getByTestId("tree-git-src")).toHaveTextContent("C"))
  })

  it("renders no badge for a clean workspace", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree
        rootPath="/repo"
        activePath={null}
        onOpenFile={jest.fn()}
        deps={deps}
        gitDecorations={new Map()}
      />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    expect(screen.queryByTestId("tree-git-src")).toBeNull()
    expect(screen.queryByTestId("tree-git-readme.md")).toBeNull()
  })
})

describe("collapse-all and reveal", () => {
  it("collapses every expanded directory but keeps the root", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("tree-row-src"))
    await waitFor(() => expect(screen.getByTestId("tree-row-src/a.ts")).toBeInTheDocument())

    fireEvent.click(screen.getByTestId("tree-collapse-all"))
    expect(screen.queryByTestId("tree-row-src/a.ts")).toBeNull()
    // Root rows stay put — only the expansion set resets.
    expect(screen.getByTestId("tree-row-src")).toBeInTheDocument()
  })

  it("reveal-active expands the ancestors of the active file", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath="src/a.ts" onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    expect(screen.queryByTestId("tree-row-src/a.ts")).toBeNull()

    fireEvent.click(screen.getByTestId("tree-reveal-active"))
    await waitFor(() => expect(screen.getByTestId("tree-row-src/a.ts")).toBeInTheDocument())
  })

  it("answers an external revealRequest the same way", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree
        rootPath="/repo"
        activePath={null}
        onOpenFile={jest.fn()}
        deps={deps}
        revealRequest={{ path: "src/a.ts", nonce: 1 }}
      />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src/a.ts")).toBeInTheDocument())
  })
})

describe("drag-move", () => {
  const TREE_MIME = "application/x-cognia-tree-row"
  const treeDt = () => {
    const data: Record<string, string> = {}
    return {
      types: [TREE_MIME],
      effectAllowed: "",
      dropEffect: "",
      setData: (k: string, v: string) => {
        data[k] = v
      },
      getData: (k: string) => data[k] ?? "",
    }
  }

  it("moves a file into a directory through the rename path", async () => {
    const deps = makeDeps()
    const onRenamed = jest.fn()
    render(
      <ProjectFileTree
        rootPath="/repo"
        activePath={null}
        onOpenFile={jest.fn()}
        deps={deps}
        onRenamed={onRenamed}
      />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    const dt = treeDt()
    fireEvent.dragStart(screen.getByTestId("tree-row-readme.md"), { dataTransfer: dt })
    fireEvent.drop(screen.getByTestId("tree-row-src"), { dataTransfer: dt })
    await waitFor(() =>
      expect(deps.renameEntry).toHaveBeenCalledWith("/repo", "readme.md", "src/readme.md")
    )
    expect(onRenamed).toHaveBeenCalledWith("readme.md", "src/readme.md")
  })

  it("refuses to drop a directory into itself", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    const dt = treeDt()
    fireEvent.dragStart(screen.getByTestId("tree-row-src"), { dataTransfer: dt })
    fireEvent.drop(screen.getByTestId("tree-row-src"), { dataTransfer: dt })
    await act(async () => {})
    expect(deps.renameEntry).not.toHaveBeenCalled()
  })

  it("refuses to drop a directory into its own descendant", async () => {
    const deps = makeDeps()
    deps.fs.src.push(entry("src/deep", true))
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("tree-row-src"))
    await waitFor(() => expect(screen.getByTestId("tree-row-src/deep")).toBeInTheDocument())
    const dt = treeDt()
    fireEvent.dragStart(screen.getByTestId("tree-row-src"), { dataTransfer: dt })
    fireEvent.drop(screen.getByTestId("tree-row-src/deep"), { dataTransfer: dt })
    await act(async () => {})
    expect(deps.renameEntry).not.toHaveBeenCalled()
  })

  it("drops onto empty space land at the workspace root", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    // Stage a file inside src by expanding it first.
    fireEvent.click(screen.getByTestId("tree-row-src"))
    await waitFor(() => expect(screen.getByTestId("tree-row-src/a.ts")).toBeInTheDocument())
    const dt = treeDt()
    fireEvent.dragStart(screen.getByTestId("tree-row-src/a.ts"), { dataTransfer: dt })
    fireEvent.drop(screen.getByTestId("project-file-tree-scroll"), { dataTransfer: dt })
    await waitFor(() => expect(deps.renameEntry).toHaveBeenCalledWith("/repo", "src/a.ts", "a.ts"))
  })

  it("highlights the directory row under the drag, not the root container", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    const dt = treeDt()
    fireEvent.dragStart(screen.getByTestId("tree-row-readme.md"), { dataTransfer: dt })
    fireEvent.dragOver(screen.getByTestId("tree-row-src"), { dataTransfer: dt })
    // Without stopPropagation the dragover bubbles to the scroll container,
    // which claims the highlight for the root.
    expect(screen.getByTestId("tree-row-src")).toHaveClass("bg-primary/15")
    expect(screen.getByTestId("project-file-tree-scroll")).not.toHaveClass("bg-accent/30")
  })

  it("drops onto a file row land in that file's directory, never the root", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("tree-row-src"))
    await waitFor(() => expect(screen.getByTestId("tree-row-src/a.ts")).toBeInTheDocument())
    const dt = treeDt()
    fireEvent.dragStart(screen.getByTestId("tree-row-readme.md"), { dataTransfer: dt })
    // A file row is a drop target for its parent dir — the drop must not
    // bubble to the scroll container's root handler.
    fireEvent.drop(screen.getByTestId("tree-row-src/a.ts"), { dataTransfer: dt })
    await waitFor(() =>
      expect(deps.renameEntry).toHaveBeenCalledWith("/repo", "readme.md", "src/readme.md")
    )
  })
})

describe("new file from template", () => {
  it("prefills the suggested name and writes the scaffold content", async () => {
    const deps = makeDeps()
    const onOpenFile = jest.fn()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={onOpenFile} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    // The root context menu flattens inline — its template items render last.
    fireEvent.click(screen.getAllByText("templates.markdown").at(-1)!)
    const input = await screen.findByPlaceholderText("templates.markdown")
    expect(input).toHaveValue("README.md")
    fireEvent.change(input, { target: { value: "notes.md" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(deps.writeFile).toHaveBeenCalledWith("/repo", "notes.md", "# notes\n")
    )
    expect(onOpenFile).toHaveBeenCalledWith("notes.md")
  })

  it("derives the component export from the final filename", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    fireEvent.click(screen.getAllByText("templates.reactComponent").at(-1)!)
    const input = await screen.findByPlaceholderText("templates.reactComponent")
    fireEvent.change(input, { target: { value: "my-widget.tsx" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(deps.writeFile).toHaveBeenCalledWith(
        "/repo",
        "my-widget.tsx",
        expect.stringContaining("export function MyWidget()")
      )
    )
  })
})
