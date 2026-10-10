/** @jest-environment jsdom */
import { act, fireEvent, render, screen } from "@testing-library/react"

import type { LoadedConversationFileSpace } from "@/lib/filespace/load"
import { useFileSpacePanelStore } from "@/stores/filespace/filespace-panel-store"
import type { FileSpaceDexieEntry, FileSpaceMount, FileSpacePath } from "@/types/filespace"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/hooks/filespace/use-conversation-filespace", () => ({
  useConversationFileSpace: jest.fn(),
}))
jest.mock("@/lib/filespace/open", () => ({ openFileSpacePath: jest.fn(async () => "opened") }))
jest.mock("@/lib/db/session-assets", () => ({ getSessionAsset: jest.fn() }))
jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))
// The dialog has its own suite; this one pins what the panel hands it.
const mockShareDialog = jest.fn()
jest.mock("@/components/share/share-link-dialog", () => ({
  ShareLinkDialog: (props: Record<string, unknown>) => {
    mockShareDialog(props)
    return <div data-testid="share-dialog" />
  },
}))
// Live sharing reads the host; the section has its own suite.
jest.mock("@/hooks/filespace/use-live-file-share", () => ({ useLiveFileShare: jest.fn() }))
const mockLiveSection = jest.fn()
jest.mock("./live-sharing-section", () => ({
  ...jest.requireActual("./live-sharing-section"),
  LiveSharingSection: (props: Record<string, unknown>) => {
    mockLiveSection(props)
    return <div data-testid="live-section" />
  },
}))
jest.mock("@/lib/files/download", () => ({ downloadBlob: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/lib/tauri/clipboard", () => ({ writeClipboardText: jest.fn(async () => undefined) }))

import { toast } from "sonner"
import { useConversationFileSpace } from "@/hooks/filespace/use-conversation-filespace"
import { useLiveFileShare } from "@/hooks/filespace/use-live-file-share"
import { getSessionAsset } from "@/lib/db/session-assets"
import { getSession } from "@/lib/db/sessions"
import { downloadBlob } from "@/lib/files/download"
import { openFileSpacePath } from "@/lib/filespace/open"
import { writeClipboardText } from "@/lib/tauri/clipboard"

import { TooltipProvider } from "@/components/ui/tooltip"

import { ConversationFilesPanel } from "./conversation-files-panel"

// `TooltipProvider` is mounted once in `app/layout.tsx`.
const wrapper = TooltipProvider

const useSpace = useConversationFileSpace as jest.Mock
const p = (value: string) => value as FileSpacePath

const WORKSPACE: FileSpaceMount = {
  id: "workspace",
  virtualPath: "/workspace",
  backing: "disk",
  label: "app",
  hostPath: "/wt/s1/app",
  containerPath: "/workspace",
  managed: true,
  role: "primary",
  logicalRootId: "root-main",
  writable: true,
  status: "available",
}
const DOCS: FileSpaceMount = {
  ...WORKSPACE,
  id: "root:docs",
  virtualPath: "/roots/docs",
  label: "docs",
  hostPath: "/docs",
  managed: false,
  role: "additional",
  status: "offline",
  statusReason: "host-offline",
  writable: false,
}
delete (DOCS as Partial<FileSpaceMount>).containerPath

function entry(
  mountId: "uploads" | "artifacts",
  name: string,
  sourceId: string,
  extra: Partial<FileSpaceDexieEntry> = {}
): FileSpaceDexieEntry {
  return {
    mountId,
    path: p(`/${mountId}/${name}`),
    name,
    size: 2048,
    mediaType: "text/plain",
    createdAt: 1,
    updatedAt: 1,
    sourceId,
    sourceAvailable: true,
    ...extra,
  }
}

function loaded(
  overrides: Partial<LoadedConversationFileSpace["space"]> = {}
): LoadedConversationFileSpace {
  return {
    space: {
      sessionId: "s1",
      hostId: "local",
      status: "available",
      mounts: [WORKSPACE, DOCS],
      ...overrides,
    },
    dexie: {
      uploads: [
        entry("uploads", "report.pdf", "asset-1"),
        entry("uploads", "old.zip", "asset-2", { sourceAvailable: false }),
      ],
      artifacts: [entry("artifacts", "Util.ts", "art-1")],
    },
  }
}

const UNSUPPORTED = {
  status: null,
  grants: [],
  error: "unknown_command",
  errorMessage: null,
  loading: false,
  reload: jest.fn(),
}

beforeEach(() => {
  jest.clearAllMocks()
  useFileSpacePanelStore.setState({ focus: null })
  ;(useLiveFileShare as jest.Mock).mockReturnValue(UNSUPPORTED)
})

describe("ConversationFilesPanel", () => {
  it("shows each state before there is a FileSpace to list", () => {
    useSpace.mockReturnValue(undefined)
    const { rerender } = render(<ConversationFilesPanel sessionId={null} />, { wrapper })
    expect(screen.getByTestId("filespace-no-session")).toBeTruthy()

    rerender(<ConversationFilesPanel sessionId="s1" />)
    expect(screen.getByTestId("filespace-loading")).toBeTruthy()

    useSpace.mockReturnValue(loaded({ status: "deleted", mounts: [] }))
    rerender(<ConversationFilesPanel sessionId="s1" />)
    expect(screen.getByTestId("filespace-deleted")).toBeTruthy()

    useSpace.mockReturnValue({
      ...loaded({ mounts: [], status: "offline" }),
      dexie: { uploads: [], artifacts: [] },
    })
    rerender(<ConversationFilesPanel sessionId="s1" />)
    expect(screen.getByTestId("filespace-empty")).toBeTruthy()
  })

  it("lists folders with where they live and why they are unavailable", () => {
    useSpace.mockReturnValue(loaded())
    render(<ConversationFilesPanel sessionId="s1" />, { wrapper })

    const workspace = screen.getByTestId("filespace-mount-workspace")
    expect(workspace.textContent).toContain("app")
    expect(workspace.textContent).toContain("/wt/s1/app")
    expect(workspace.textContent).toContain('mount.container:{"path":"/workspace"}')
    expect(workspace.textContent).toContain("mount.managed")
    expect(workspace.textContent).toContain("mount.primary")

    const docs = screen.getByTestId("filespace-mount-root:docs")
    expect(docs.textContent).toContain("status.offline")
    expect(docs.textContent).toContain("reason.hostOffline")
    expect(docs.textContent).toContain("mount.additional")
    expect(docs.querySelector('button[aria-label="actions.open"]')).toBeDisabled()
  })

  it("opens and links folders and artifacts through the FileSpace", async () => {
    useSpace.mockReturnValue(loaded())
    render(<ConversationFilesPanel sessionId="s1" />, { wrapper })

    const workspace = screen.getByTestId("filespace-mount-workspace")
    fireEvent.click(workspace.querySelector('button[aria-label="actions.open"]')!)
    expect(openFileSpacePath).toHaveBeenCalledWith({ sessionId: "s1", path: "/workspace" })

    fireEvent.click(
      screen
        .getByTestId("filespace-entry-art-1")
        .querySelector('button[aria-label="actions.open"]')!
    )
    expect(openFileSpacePath).toHaveBeenLastCalledWith({
      sessionId: "s1",
      path: "/artifacts/Util.ts",
    })

    fireEvent.click(
      screen
        .getByTestId("filespace-entry-asset-1")
        .querySelector('button[aria-label="actions.copyLink"]')!
    )
    await act(async () => {})
    expect(writeClipboardText).toHaveBeenCalledWith(
      "cognia://session/s1?view=files&path=%2Fuploads%2Freport.pdf"
    )
    expect(toast.success).toHaveBeenCalledWith("toast.linkCopied")
  })

  it("reports an open that could not land", async () => {
    ;(openFileSpacePath as jest.Mock).mockResolvedValueOnce("offline")
    useSpace.mockReturnValue(loaded())
    render(<ConversationFilesPanel sessionId="s1" />, { wrapper })
    fireEvent.click(
      screen
        .getByTestId("filespace-mount-workspace")
        .querySelector('button[aria-label="actions.open"]')!
    )
    await act(async () => {})
    expect(toast.error).toHaveBeenCalledWith("toast.openFailed.offline")
  })

  it("downloads an upload's original, and says when it is gone", async () => {
    const blob = new Blob(["x"])
    ;(getSessionAsset as jest.Mock).mockResolvedValueOnce({ blob, filename: "report.pdf" })
    useSpace.mockReturnValue(loaded())
    render(<ConversationFilesPanel sessionId="s1" />, { wrapper })

    const download = (id: string) =>
      screen
        .getByTestId(`filespace-entry-${id}`)
        .querySelector('button[aria-label="actions.download"]')!
    expect(download("asset-2")).toBeDisabled()
    expect(screen.getByTestId("filespace-entry-asset-2").textContent).toContain(
      "entry.sourceUnavailable"
    )

    fireEvent.click(download("asset-1"))
    await act(async () => {})
    expect(getSessionAsset).toHaveBeenCalledWith("s1", "asset-1")
    expect(downloadBlob).toHaveBeenCalledWith(blob, "report.pdf")

    ;(getSessionAsset as jest.Mock).mockResolvedValueOnce(undefined)
    fireEvent.click(download("asset-1"))
    await act(async () => {})
    expect(toast.error).toHaveBeenCalledWith("toast.downloadUnavailable")
  })

  it("highlights a focused row of this conversation and ignores another's", async () => {
    useSpace.mockReturnValue(loaded())
    render(<ConversationFilesPanel sessionId="s1" />, { wrapper })

    act(() => useFileSpacePanelStore.getState().requestFocus("s2", p("/uploads/report.pdf")))
    await act(async () => {})
    expect(screen.getByTestId("filespace-entry-asset-1").className).not.toContain("border-primary")
    expect(useFileSpacePanelStore.getState().focus).not.toBeNull()

    act(() => useFileSpacePanelStore.getState().requestFocus("s1", p("/uploads/report.pdf")))
    await act(async () => {})
    expect(screen.getByTestId("filespace-entry-asset-1").className).toContain("border-primary")
    expect(useFileSpacePanelStore.getState().focus).toBeNull()

    act(() => useFileSpacePanelStore.getState().requestFocus("s1", p("/workspace/src/a.ts")))
    await act(async () => {})
    expect(screen.getByTestId("filespace-mount-workspace").className).toContain("border-primary")
    expect(screen.getByTestId("filespace-focused-path").textContent).toContain(
      "/workspace/src/a.ts"
    )
  })

  it("names the remote host the files live on", () => {
    useSpace.mockReturnValue(loaded({ hostId: "h1", hostLabel: "build box" }))
    render(<ConversationFilesPanel sessionId="s1" />, { wrapper })
    expect(screen.getByTestId("filespace-host").textContent).toBe(
      'host.remote:{"label":"build box"}'
    )
  })

  describe("sharing files", () => {
    const SESSION = { id: "s1", title: "Refactor" }
    const shareButton = (testId: string) =>
      screen.getByTestId(testId).querySelector('button[aria-label="actions.share"]')!
    const lastDialogProps = () =>
      mockShareDialog.mock.lastCall?.[0] as {
        open: boolean
        onOpenChange: (next: boolean) => void
        buildPayload: () => unknown
        files: { session: unknown; initialSelection: FileSpacePath[]; required: boolean }
      }

    it("opens a file bundle on the conversation with nothing preselected", async () => {
      ;(getSession as jest.Mock).mockResolvedValue(SESSION)
      useSpace.mockReturnValue(loaded())
      render(<ConversationFilesPanel sessionId="s1" />, { wrapper })
      expect(screen.queryByTestId("share-dialog")).toBeNull()

      fireEvent.click(screen.getByRole("button", { name: "actions.shareFiles" }))
      await act(async () => {})
      expect(getSession).toHaveBeenCalledWith("s1")
      const props = lastDialogProps()
      expect(props.open).toBe(true)
      expect(props.files).toEqual({ session: SESSION, initialSelection: [], required: true })
      expect(props.buildPayload()).toEqual({
        kind: "file-bundle",
        mime: "application/json",
        data: "",
        encoding: "utf8",
        title: 'share.bundleTitle:{"title":"Refactor"}',
      })

      act(() => props.onOpenChange(false))
      expect(screen.queryByTestId("share-dialog")).toBeNull()
    })

    it("preselects the row a share starts from, and remounts for each request", async () => {
      ;(getSession as jest.Mock).mockResolvedValue({ id: "s1", title: "" })
      useSpace.mockReturnValue(loaded())
      render(<ConversationFilesPanel sessionId="s1" />, { wrapper })

      fireEvent.click(shareButton("filespace-mount-workspace"))
      await act(async () => {})
      expect(lastDialogProps().files.initialSelection).toEqual(["/workspace"])
      expect(lastDialogProps().buildPayload()).toMatchObject({
        title: 'share.bundleTitle:{"title":"share.untitled"}',
      })

      fireEvent.click(shareButton("filespace-entry-art-1"))
      await act(async () => {})
      expect(lastDialogProps().files.initialSelection).toEqual(["/artifacts/Util.ts"])
    })

    it("offers no share for a row it could not read", () => {
      useSpace.mockReturnValue(loaded())
      render(<ConversationFilesPanel sessionId="s1" />, { wrapper })
      expect(shareButton("filespace-mount-root:docs")).toBeDisabled()
      expect(shareButton("filespace-entry-asset-2")).toBeDisabled()
      expect(shareButton("filespace-entry-asset-1")).toBeEnabled()
    })

    it("says so when the conversation cannot be loaded for sharing", async () => {
      ;(getSession as jest.Mock).mockResolvedValueOnce(undefined)
      useSpace.mockReturnValue(loaded())
      render(<ConversationFilesPanel sessionId="s1" />, { wrapper })
      fireEvent.click(screen.getByRole("button", { name: "actions.shareFiles" }))
      await act(async () => {})
      expect(toast.error).toHaveBeenCalledWith("toast.shareUnavailable")
      expect(screen.queryByTestId("share-dialog")).toBeNull()
    })
  })

  describe("sharing as a network drive", () => {
    const OFFERED = {
      ...UNSUPPORTED,
      error: null,
      status: {
        active: true,
        policy: { allowLiveGrants: true, allowProtocolCredentials: true },
      },
    }
    const liveButton = (testId: string) =>
      screen.getByTestId(testId).querySelector('button[aria-label="grants.newShare"]')
    const lastSection = () =>
      mockLiveSection.mock.lastCall?.[0] as {
        request: { seq: number; paths: FileSpacePath[] } | null
        onCloseRequest: () => void
        space: { sessionId: string }
      }

    it("reads this conversation's host only once its files are known", () => {
      useSpace.mockReturnValue(undefined)
      const { rerender } = render(<ConversationFilesPanel sessionId="s1" />, { wrapper })
      expect(useLiveFileShare).toHaveBeenLastCalledWith({
        sessionId: "s1",
        hostId: undefined,
        enabled: false,
      })
      useSpace.mockReturnValue(loaded({ hostId: "h1" }))
      rerender(<ConversationFilesPanel sessionId="s1" />)
      expect(useLiveFileShare).toHaveBeenLastCalledWith({
        sessionId: "s1",
        hostId: "h1",
        enabled: true,
      })
    })

    it("offers no row action where the host cannot share live", () => {
      useSpace.mockReturnValue(loaded())
      render(<ConversationFilesPanel sessionId="s1" />, { wrapper })
      expect(liveButton("filespace-mount-workspace")).toBeNull()
      expect(liveButton("filespace-entry-art-1")).toBeNull()
    })

    it("opens the live share on the row it starts from", () => {
      ;(useLiveFileShare as jest.Mock).mockReturnValue(OFFERED)
      useSpace.mockReturnValue(loaded())
      render(<ConversationFilesPanel sessionId="s1" />, { wrapper })
      expect(liveButton("filespace-mount-root:docs")).toBeDisabled()
      expect(liveButton("filespace-entry-asset-2")).toBeNull()
      expect(lastSection().request).toBeNull()

      fireEvent.click(liveButton("filespace-mount-workspace")!)
      expect(lastSection().request).toEqual({ seq: 1, paths: ["/workspace"] })
      fireEvent.click(liveButton("filespace-entry-asset-1")!)
      expect(lastSection().request).toEqual({ seq: 2, paths: ["/uploads/report.pdf"] })
      act(() => lastSection().onCloseRequest())
      expect(lastSection().request).toBeNull()
      expect(lastSection().space.sessionId).toBe("s1")
    })
  })
})
