import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { RemoteFileBrowser } from "./remote-file-browser"

const resolveSftpPath = jest.fn()
const statSftpEntry = jest.fn()
const enqueueSftpDownload = jest.fn()
const enqueueSftpUpload = jest.fn()
let treeProps: Record<string, unknown> = {}

jest.mock("@/lib/sftp/client", () => ({
  createSftpFileTreeDeps: (profileId: string) => ({ profileId }),
  joinRemotePath: (base: string, rel?: string) =>
    rel ? `${base.replace(/\/+$/, "")}/${rel}` : base,
  resolveSftpPath: (...args: unknown[]) => resolveSftpPath(...args),
  statSftpEntry: (...args: unknown[]) => statSftpEntry(...args),
}))
jest.mock("@/lib/sftp/transfer-queue", () => ({
  enqueueSftpDownload: (...args: unknown[]) => enqueueSftpDownload(...args),
  enqueueSftpUpload: (...args: unknown[]) => enqueueSftpUpload(...args),
}))
jest.mock("@/components/editor/project/project-file-tree", () => ({
  ProjectFileTree: (props: Record<string, unknown>) => {
    treeProps = props
    return <div data-testid="tree" data-root={String(props.rootPath)} />
  },
}))

beforeEach(() => {
  resolveSftpPath.mockReset().mockResolvedValue("/home/deploy")
  statSftpEntry.mockReset().mockResolvedValue({ size: 42 })
  enqueueSftpDownload.mockReset().mockResolvedValue("t1")
  enqueueSftpUpload.mockReset().mockResolvedValue("t2")
  treeProps = {}
})

const browser = () => <RemoteFileBrowser profileId="production" profileLabel="Production" />

describe("RemoteFileBrowser", () => {
  /**
   * `/home/<user>` is wrong for root, for macOS, for a chrooted account and for
   * anything with a non-default home, and the failure a guess produces is an
   * empty directory rather than an error. The machine is asked instead.
   */
  it("asks the machine where home is rather than guessing", async () => {
    render(browser())
    await waitFor(() =>
      expect(screen.getByTestId("tree")).toHaveAttribute("data-root", "/home/deploy")
    )
    expect(resolveSftpPath).toHaveBeenCalledWith("production", ".")
  })

  /**
   * Falling back to the root beats rendering nothing, and the reason home could
   * not be resolved is shown rather than swallowed.
   */
  it("falls back to the root and says why when home cannot be resolved", async () => {
    resolveSftpPath.mockRejectedValue(new Error("Permission denied"))
    render(browser())
    await waitFor(() => expect(screen.getByTestId("tree")).toHaveAttribute("data-root", "/"))
    expect(screen.getByTestId("sftp-notice")).toHaveTextContent("Permission denied")
  })

  /** ADR-0162 states the reach where a path bar would otherwise imply one. */
  it("says it browses the whole machine", async () => {
    render(browser())
    await screen.findByTestId("tree")
    expect(screen.getByText(/no folder limit to enforce/i)).toBeInTheDocument()
  })

  /**
   * There is nowhere to open a remote file: it is not on disk here. Queueing a
   * download is the honest action, and the queue is where progress belongs.
   */
  it("queues a download instead of pretending it can open the file", async () => {
    render(browser())
    await screen.findByTestId("tree")
    act(() => (treeProps.onOpenFile as (rel: string) => void)("app.log"))
    await waitFor(() =>
      expect(enqueueSftpDownload).toHaveBeenCalledWith({
        profileId: "production",
        profileLabel: "Production",
        remotePath: "/home/deploy/app.log",
        size: 42,
      })
    )
  })

  it("walks up from the folder it is showing", async () => {
    render(browser())
    await waitFor(() =>
      expect(screen.getByTestId("tree")).toHaveAttribute("data-root", "/home/deploy")
    )
    await userEvent.click(screen.getByRole("button", { name: "Go up one folder" }))
    expect(screen.getByTestId("tree")).toHaveAttribute("data-root", "/home")
  })

  it("goes where the path bar says on Enter", async () => {
    render(browser())
    await screen.findByTestId("tree")
    const path = screen.getByTestId("sftp-path")
    await userEvent.clear(path)
    await userEvent.type(path, "/var/log{Enter}")
    expect(screen.getByTestId("tree")).toHaveAttribute("data-root", "/var/log")
  })

  /**
   * A listing failure reaches the surface that owns the tree. The tree renders
   * it in place too, and this is the second half: a reason that scrolls away
   * with a toast leaves a directory looking empty.
   */
  it("renders a listing failure with the path it happened to", async () => {
    render(browser())
    await screen.findByTestId("tree")
    act(() =>
      (treeProps.onFailure as (f: unknown, o: string, p: string) => void)(
        { kind: "denied", detail: null, code: null },
        "list",
        "secrets"
      )
    )
    await waitFor(() =>
      expect(screen.getByTestId("sftp-failure")).toHaveTextContent("/home/deploy/secrets")
    )
  })
})
