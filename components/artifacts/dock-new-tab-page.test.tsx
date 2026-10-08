/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { UIMessage } from "ai"

import {
  CHROME_WEB_STORE_URL,
  DockNewTabPage,
  resolveOmniboxTarget,
  type DockNewTabPageProps,
} from "./dock-new-tab-page"
import { useLocalBrowser } from "@/hooks/browser/use-local-browser"
import { serveLocalFile } from "@/lib/browser/local-content-client"
import {
  getActiveContextResource,
  getActiveWorkbenchPanels,
} from "@/lib/context-workbench/active-context"
import { requestCommandPalette } from "@/lib/shell/command-palette-request"
import { terminalAvailable } from "@/lib/terminal/pick-transport"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { toast } from "sonner"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}${JSON.stringify(values)}` : key,
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))
jest.mock("@/hooks/browser/use-local-browser", () => ({ useLocalBrowser: jest.fn() }))
let recentPages: string[] = []
jest.mock("@/hooks/browser/use-recent-pages", () => ({
  useRecentPages: () => ({ recent: recentPages, clear: jest.fn() }),
}))
let changedFiles = { files: 0, insertions: 0, deletions: 0, linesKnown: true }
jest.mock("@/hooks/chat/use-session-resource-changes", () => ({
  useSessionResourceChanges: () => ({ totals: changedFiles }),
}))
jest.mock("@/lib/browser/local-content-client", () => ({
  ...jest.requireActual("@/lib/browser/local-content-client"),
  serveLocalFile: jest.fn(),
}))
jest.mock("@/lib/context-workbench/active-context", () => ({
  getActiveContextResource: jest.fn(),
  getActiveWorkbenchPanels: jest.fn(),
  getActiveContextRevision: () => 0,
  subscribeActiveContext: () => () => {},
}))
jest.mock("@/lib/shell/command-palette-request", () => ({ requestCommandPalette: jest.fn() }))
jest.mock("@/lib/terminal/pick-transport", () => ({ terminalAvailable: jest.fn(() => true) }))
jest.mock("@/components/browser/local-content/browser-local-content-picker", () => ({
  BrowserLocalContentPicker: ({ onOpen }: { onOpen: (url: string) => void }) => (
    <button type="button" onClick={() => onOpen("http://localhost:5173/")}>
      dev server
    </button>
  ),
}))
jest.mock("@/components/browser/launch/browser-launch-configs", () => ({
  BrowserLaunchConfigs: ({
    sessionId,
    onOpen,
  }: {
    sessionId: string | null
    onOpen: (url: string) => void
  }) => (
    <button type="button" onClick={() => onOpen("http://localhost:3000/")}>
      {`launch ${sessionId}`}
    </button>
  ),
}))
jest.mock("@/components/browser/browser-backend-switcher", () => ({
  LocalChromiumInstall: () => <div data-testid="chromium-install" />,
}))
jest.mock("@/components/browser/extensions/browser-extensions-panel", () => ({
  BrowserExtensionsPanel: ({ backend, sessionId }: { backend: string; sessionId?: string }) => (
    <div data-testid="extensions-panel">{`${backend}:${sessionId ?? "settings"}`}</div>
  ),
}))

const onOpenPanel = jest.fn()
const onOpenPage = jest.fn()

function local(installed: boolean | null, supported = true) {
  jest.mocked(useLocalBrowser).mockReturnValue({
    supported,
    status:
      installed === null
        ? null
        : {
            installed,
            installing: false,
            chromiumVersion: null,
            running: false,
            runtimeStaged: true,
            error: null,
          },
  } as never)
}

function renderPage(props: Partial<DockNewTabPageProps> = {}) {
  return render(
    <DockNewTabPage
      sessionId="s1"
      messages={[]}
      onOpenPanel={onOpenPanel}
      onOpenPage={onOpenPage}
      desktop={false}
      {...props}
    />
  )
}

/** The last address opened as a page tab in this tab's place. */
function lastBrowserRequest() {
  return (onOpenPage.mock.calls.at(-1)?.[0] as string | undefined) ?? null
}

beforeEach(() => {
  jest.clearAllMocks()
  localStorage.clear()
  recentPages = []
  changedFiles = { files: 0, insertions: 0, deletions: 0, linesKnown: true }
  local(null, false)
  jest.mocked(terminalAvailable).mockReturnValue(true)
  jest.mocked(getActiveContextResource).mockReturnValue({
    kind: "session",
    sessionId: "s1",
    capabilities: [],
  })
  jest.mocked(getActiveWorkbenchPanels).mockReturnValue([
    { id: "new-tab", activity: "preview-run", labelKey: "contextWorkbench.newTab.title" },
    { id: "workspace", activity: "workspace", labelKey: "artifacts.dock.workspaceMode" },
    { id: "session-sidechat", activity: "ai", labelKey: "contextWorkbench.sessionSidechat" },
    { id: "browser", activity: "preview-run", labelKey: "browser.title" },
    { id: "metadata", activity: "inspect", labelKey: "contextWorkbench.metadata.sessionTitle" },
    { id: "memory", activity: "inspect", labelKey: "contextWorkbench.memoryPanel.title" },
  ])
  useArtifactDockLayoutStore.getState().resetLayout()
  useArtifactDockLayoutStore.setState({ browserRequestUrl: null, revealIntent: null })
  useArtifactStore.setState({ artifacts: {}, activeArtifactIdBySession: {} })
  useTerminalStore.setState({ panelOpen: false })
})

describe("resolveOmniboxTarget", () => {
  it.each([
    ["", null],
    ["   ", null],
    ["example.com", { kind: "url", url: "https://example.com/" }],
    ["localhost:3000", { kind: "url", url: "http://localhost:3000/" }],
    ["http://intranet", { kind: "url", url: "http://intranet/" }],
    ["192.168.1.4:8080/app", { kind: "url", url: "http://192.168.1.4:8080/app" }],
    // A bare word would otherwise open https://react/.
    ["react", { kind: "search", query: "react" }],
    ["fix the login bug", { kind: "search", query: "fix the login bug" }],
    ["/tmp/report.html", { kind: "path", path: "/tmp/report.html" }],
    ["file:///tmp/a.html", { kind: "path", path: "/tmp/a.html" }],
  ])("%j", (input, expected) => {
    expect(resolveOmniboxTarget(input)).toEqual(expected)
  })
})

describe("DockNewTabPage omnibox", () => {
  it("opens an address in the dock's browser", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.type(screen.getByRole("textbox", { name: "omniboxLabel" }), "example.com{Enter}")
    expect(lastBrowserRequest()).toBe("https://example.com/")
  })

  it("hands anything else to the command palette with the words typed", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.type(screen.getByRole("textbox", { name: "omniboxLabel" }), "auth token{Enter}")
    expect(requestCommandPalette).toHaveBeenCalledWith({ query: "auth token" })
    expect(lastBrowserRequest()).toBeNull()
  })

  it("serves a local file on the desktop, and says when it cannot", async () => {
    const user = userEvent.setup()
    jest
      .mocked(serveLocalFile)
      .mockResolvedValueOnce({ url: "http://127.0.0.1:9/a.html", root: "r" })
    renderPage({ desktop: true })
    const box = screen.getByRole("textbox", { name: "omniboxLabel" })
    await user.type(box, "/tmp/a.html{Enter}")
    await waitFor(() => expect(lastBrowserRequest()).toBe("http://127.0.0.1:9/a.html"))

    jest.mocked(serveLocalFile).mockRejectedValueOnce(new Error("denied"))
    await user.clear(box)
    await user.type(box, "/tmp/b.html{Enter}")
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('openFailed{"path":"/tmp/b.html"}')
    )
  })

  it("cannot serve local files off the desktop", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.type(screen.getByRole("textbox", { name: "omniboxLabel" }), "/tmp/a.html{Enter}")
    expect(serveLocalFile).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
  })
})

describe("DockNewTabPage tools", () => {
  it("opens this task's tools in place, with the changes' line totals", () => {
    changedFiles = { files: 2, insertions: 12, deletions: 3, linesKnown: true }
    renderPage()
    const tools = screen.getByRole("region", { name: "tools" })
    expect(within(tools).getByTestId("dock-new-tab-tool-workspace")).toHaveTextContent("+12 −3")
    fireEvent.click(within(tools).getByTestId("dock-new-tab-tool-workspace"))
    expect(onOpenPanel).toHaveBeenCalledWith("workspace")
    fireEvent.click(within(tools).getByTestId("dock-new-tab-tool-session-sidechat"))
    expect(onOpenPanel).toHaveBeenCalledWith("session-sidechat")
  })

  it("lists the remaining tools, but never itself, under More tools", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByTestId("dock-new-tab-more-tools"))
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent)
    expect(items).toEqual(["contextWorkbench.memoryPanel.title"])
    await user.click(screen.getByRole("menuitem", { name: "contextWorkbench.memoryPanel.title" }))
    expect(onOpenPanel).toHaveBeenCalledWith("memory")
  })

  it("offers no tools while another resource is the active workbench", () => {
    jest.mocked(getActiveContextResource).mockReturnValue({
      kind: "artifact",
      artifactId: "a1",
      version: "1",
      capabilities: [],
    })
    renderPage()
    expect(screen.queryByTestId("dock-new-tab-tool-workspace")).toBeNull()
  })

  it("toggles the bottom terminal rather than opening a dock tab", () => {
    renderPage()
    const terminal = screen.getByTestId("dock-new-tab-tool-terminal")
    fireEvent.click(terminal)
    expect(useTerminalStore.getState().panelOpen).toBe(true)
    expect(terminal).toHaveAttribute("aria-pressed", "true")
    expect(onOpenPanel).not.toHaveBeenCalled()
  })

  it("never offers the browser as a tool: pages open by address", async () => {
    const user = userEvent.setup()
    renderPage()
    expect(screen.queryByTestId("dock-new-tab-tool-browser")).toBeNull()
    await user.click(screen.getByTestId("dock-new-tab-more-tools"))
    expect(screen.queryByRole("menuitem", { name: "browser.title" })).toBeNull()
  })

  it("manages Chromium's extensions in a dialog once it is installed", async () => {
    local(false)
    const view = renderPage({ desktop: true })
    expect(screen.queryByTestId("dock-new-tab-tool-extensions")).toBeNull()
    view.unmount()
    local(true)
    renderPage({ desktop: true })
    fireEvent.click(screen.getByTestId("dock-new-tab-tool-extensions"))
    expect(await screen.findByTestId("extensions-panel")).toHaveTextContent(
      "local-chromium:settings"
    )
  })

  it("hides the terminal where there is none", () => {
    jest.mocked(terminalAvailable).mockReturnValue(false)
    renderPage()
    expect(screen.queryByTestId("dock-new-tab-tool-terminal")).toBeNull()
  })
})

describe("DockNewTabPage content", () => {
  it("lists this task's artifacts, newest first, and opens one", () => {
    act(() =>
      useArtifactStore.setState({
        artifacts: {
          a1: { id: "a1", sessionId: "s1", type: "document", title: "Old", updatedAt: 1 },
          a2: { id: "a2", sessionId: "s1", type: "code", title: "New", updatedAt: 2 },
          a3: { id: "a3", sessionId: "other", type: "code", title: "Elsewhere", updatedAt: 3 },
        } as never,
      })
    )
    renderPage()
    const list = screen.getByRole("region", { name: "artifacts" })
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => b.textContent)
    ).toEqual(["New", "Old"])
    fireEvent.click(within(list).getByText("New"))
    expect(useArtifactStore.getState().activeArtifactIdBySession.s1).toBe("a2")
  })

  it("says when the task has no artifacts", () => {
    renderPage()
    expect(screen.getByText("noArtifacts")).toBeInTheDocument()
  })

  it("suggests the links this task shared", () => {
    const messages = [
      {
        id: "m1",
        role: "assistant",
        parts: [{ type: "text", text: "Docs at https://example.com/guide" }],
      },
    ] as UIMessage[]
    renderPage({ messages })
    fireEvent.click(within(screen.getByTestId("dock-new-tab-links")).getByRole("button"))
    expect(lastBrowserRequest()).toBe("https://example.com/guide")
  })

  it("suggests dev servers and local files on the desktop", () => {
    local(true)
    renderPage({ desktop: true })
    fireEvent.click(screen.getByRole("button", { name: "dev server" }))
    expect(lastBrowserRequest()).toBe("http://localhost:5173/")
  })

  it("offers the task's launch configurations on the desktop only", () => {
    local(true)
    const view = renderPage({ desktop: true })
    fireEvent.click(screen.getByRole("button", { name: /^launch / }))
    expect(lastBrowserRequest()).toBe("http://localhost:3000/")
    view.unmount()

    renderPage({ desktop: false })
    expect(screen.queryByRole("button", { name: /^launch / })).toBeNull()
  })

  it("offers the Chrome Web Store once Chromium is installed, and the install before", () => {
    local(false)
    const view = renderPage({ desktop: true })
    expect(screen.getByTestId("chromium-install")).toBeInTheDocument()
    expect(screen.queryByTestId("dock-new-tab-web-store")).toBeNull()
    view.unmount()

    local(true)
    renderPage({ desktop: true })
    expect(screen.queryByTestId("chromium-install")).toBeNull()
    fireEvent.click(screen.getByTestId("dock-new-tab-web-store"))
    expect(lastBrowserRequest()).toBe(CHROME_WEB_STORE_URL)
  })

  it("lists recent pages, labelled as global", () => {
    recentPages = ["https://example.com/a"]
    renderPage()
    const recent = screen.getByRole("region", { name: "recent" })
    fireEvent.click(within(recent).getByRole("button"))
    expect(lastBrowserRequest()).toBe("https://example.com/a")
  })
})
