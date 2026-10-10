import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { WorkspaceEntry } from "@/lib/files/types"
import type { FileSpaceDexieListing } from "@/lib/filespace/sources"
import type {
  ConversationFileSpace,
  FileSpaceDexieEntry,
  FileSpaceMount,
  FileSpacePath,
} from "@/types/filespace"

import { ShareFilesPicker } from "./share-files-picker"

const WORKSPACE: FileSpaceMount = {
  id: "workspace",
  virtualPath: "/workspace",
  backing: "disk",
  label: "repo",
  hostPath: "/home/me/repo",
  managed: false,
  role: "primary",
  writable: true,
  status: "available",
}

function space(mounts: FileSpaceMount[]): ConversationFileSpace {
  return { sessionId: "s1", status: "available", mounts, hostId: "local" }
}

function upload(name: string, sourceAvailable = true): FileSpaceDexieEntry {
  return {
    mountId: "uploads",
    path: `/uploads/${name}` as FileSpacePath,
    name,
    size: 2048,
    mediaType: "text/plain",
    createdAt: 1,
    updatedAt: 1,
    sourceId: `asset-${name}`,
    sourceAvailable,
  }
}

function entry(relPath: string, isDir: boolean, size = 0): WorkspaceEntry {
  return { relPath, absolutePath: `/home/me/repo/${relPath}`, isDir, size, mtimeMs: null }
}

const NO_DEXIE: FileSpaceDexieListing = { uploads: [], artifacts: [] }

describe("ShareFilesPicker", () => {
  it("lists a folder lazily, one level at a time, from the mount's host directory", async () => {
    const user = userEvent.setup()
    const listDir = jest.fn(async (_root: string, rel?: string) =>
      rel === "src"
        ? [entry("src/a.ts", false, 1024)]
        : [entry("src", true), entry("README.md", false, 10)]
    )
    render(
      <ShareFilesPicker
        space={space([WORKSPACE])}
        dexie={NO_DEXIE}
        selected={[]}
        onToggle={jest.fn()}
        listDir={listDir}
      />
    )
    expect(listDir).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Show the contents of repo" }))
    expect(listDir).toHaveBeenCalledWith("/home/me/repo", undefined, false)
    expect(await screen.findByText("README.md")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Show the contents of src" }))
    expect(listDir).toHaveBeenLastCalledWith("/home/me/repo", "src", false)
    expect(await screen.findByText("a.ts")).toBeInTheDocument()
    expect(screen.getByText("1.0 KB")).toBeInTheDocument()
  })

  it("reports a folder whose listing failed, and retries when reopened", async () => {
    const user = userEvent.setup()
    const listDir = jest
      .fn()
      .mockRejectedValueOnce(new Error("EACCES"))
      .mockResolvedValueOnce([entry("ok.txt", false, 1)])
    render(
      <ShareFilesPicker
        space={space([WORKSPACE])}
        dexie={NO_DEXIE}
        selected={[]}
        onToggle={jest.fn()}
        listDir={listDir}
      />
    )
    await user.click(screen.getByRole("button", { name: "Show the contents of repo" }))
    expect(await screen.findByText("This folder could not be listed.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Hide the contents of repo" }))
    await user.click(screen.getByRole("button", { name: "Show the contents of repo" }))
    expect(await screen.findByText("ok.txt")).toBeInTheDocument()
    expect(listDir).toHaveBeenCalledTimes(2)
  })

  it("ticks FileSpace paths, and a ticked folder covers what is under it", async () => {
    const user = userEvent.setup()
    const onToggle = jest.fn()
    const listDir = jest.fn(async () => [entry("a.txt", false, 1)])
    const { rerender } = render(
      <ShareFilesPicker
        space={space([WORKSPACE])}
        dexie={NO_DEXIE}
        selected={[]}
        onToggle={onToggle}
        listDir={listDir}
      />
    )
    await user.click(screen.getByRole("checkbox", { name: "Select repo" }))
    expect(onToggle).toHaveBeenCalledWith("/workspace", true)

    await user.click(screen.getByRole("button", { name: "Show the contents of repo" }))
    await screen.findByText("a.txt")
    await user.click(screen.getByRole("checkbox", { name: "Select a.txt" }))
    expect(onToggle).toHaveBeenLastCalledWith("/workspace/a.txt", true)

    rerender(
      <ShareFilesPicker
        space={space([WORKSPACE])}
        dexie={NO_DEXIE}
        selected={["/workspace" as FileSpacePath]}
        onToggle={onToggle}
        listDir={listDir}
      />
    )
    const child = screen.getByRole("checkbox", { name: "Select a.txt" })
    expect(child).toBeChecked()
    expect(child).toBeDisabled()
    expect(screen.getByRole("checkbox", { name: "Select repo" })).toBeEnabled()
  })

  it("says why a mount cannot be read instead of offering it", () => {
    render(
      <ShareFilesPicker
        space={space([
          { ...WORKSPACE, status: "offline", statusReason: "host-offline" },
          {
            ...WORKSPACE,
            id: "root:extra",
            virtualPath: "/roots/extra",
            label: "extra",
            hostPath: undefined,
            status: "missing",
            statusReason: "managed-missing-on-device",
          },
        ])}
        dexie={NO_DEXIE}
        selected={[]}
        onToggle={jest.fn()}
        listDir={jest.fn()}
      />
    )
    expect(screen.getByText("Host offline")).toBeInTheDocument()
    expect(screen.getByText("Not on this device")).toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: "Select repo" })).toBeDisabled()
    expect(screen.getByRole("checkbox", { name: "Select extra" })).toBeDisabled()
    expect(screen.queryByRole("button", { name: /Show the contents/ })).toBeNull()
  })

  it("lists uploads and artifacts, and marks an upload whose bytes are gone", () => {
    render(
      <ShareFilesPicker
        space={space([])}
        dexie={{
          uploads: [upload("notes.txt"), upload("lost.png", false)],
          artifacts: [
            {
              ...upload("report.md"),
              mountId: "artifacts",
              path: "/artifacts/report.md" as FileSpacePath,
            },
          ],
        }}
        selected={[]}
        onToggle={jest.fn()}
        listDir={jest.fn()}
      />
    )
    expect(screen.getByRole("checkbox", { name: "Select Uploads" })).toBeEnabled()
    expect(screen.getByRole("checkbox", { name: "Select notes.txt" })).toBeEnabled()
    expect(screen.getByRole("checkbox", { name: "Select lost.png" })).toBeDisabled()
    expect(screen.getByText("No stored copy")).toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: "Select report.md" })).toBeEnabled()
    expect(screen.queryByText("This conversation has no files yet.")).toBeNull()
  })

  it("says so when the conversation has no files", async () => {
    render(
      <ShareFilesPicker
        space={space([])}
        dexie={NO_DEXIE}
        selected={[]}
        onToggle={jest.fn()}
        listDir={jest.fn()}
      />
    )
    await waitFor(() =>
      expect(screen.getByText("This conversation has no files yet.")).toBeInTheDocument()
    )
  })
})
