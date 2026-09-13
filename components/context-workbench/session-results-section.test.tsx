/** @jest-environment jsdom */
import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { UIMessage } from "ai"
import type { ChatSession } from "@cognia/agent-config-types"
import { SessionResultsSection } from "./session-results-section"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useTaskWorkspaceStore } from "@/stores/task-workspace-store"
import {
  installTaskWorkspaceEventListener,
  listTaskResources,
  listTaskWorkspaces,
} from "@/lib/task-workspace/client"
import type { ResourceChange } from "@/lib/task-workspace/types"

jest.mock("@/lib/files/workspace-backend", () => ({ hasWorkspaceFsBackend: jest.fn(() => true) }))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, args?: { count?: number }) =>
    args?.count === undefined ? key : `${key}:${args.count}`,
}))
jest.mock("@/lib/task-workspace/client", () => ({
  installTaskWorkspaceEventListener: jest.fn(),
  listTaskResources: jest.fn(),
  listTaskWorkspaces: jest.fn(),
}))
jest.mock("@/components/artifacts/artifact-list", () => ({
  ArtifactList: ({
    sessionId,
    lockSessionScope,
  }: {
    sessionId: string
    lockSessionScope: boolean
  }) => <div>{`artifacts:${sessionId}:${lockSessionScope}`}</div>,
}))
jest.mock("@/components/chat/message-parts/file-part-preview", () => ({
  FilePartPreview: ({ url, filename }: { url: string; filename?: string }) => (
    <a href={url}>{filename ?? url}</a>
  ),
}))
jest.mock("@/components/shared/external-link", () => ({
  ExternalLink: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))
const load = jest.mocked(listTaskResources)
const session = { id: "s1" } as ChatSession
const row = { path: "src/result.ts", runId: "run1", kind: "modified" } as ResourceChange
function activate(id = "s1") {
  useTaskWorkspaceStore.getState().activate({
    sessionId: id,
    taskId: `task-${id}`,
    runId: `run-${id}`,
    workspaceRoot: "/repo",
    executionRoot: "/repo",
    state: "running",
  })
}
beforeEach(() => {
  useArtifactStore.setState({ artifacts: {} })
  jest.mocked(hasWorkspaceFsBackend).mockReturnValue(true)
  useTaskWorkspaceStore.getState().clear()
  jest.mocked(listTaskWorkspaces).mockReset().mockResolvedValue([])
  jest.mocked(installTaskWorkspaceEventListener).mockReset().mockResolvedValue(jest.fn())
  load.mockReset()
  load.mockResolvedValue([])
})

it("uses a locked artifact list and distinguishes unavailable tracking", async () => {
  render(<SessionResultsSection session={session} messages={[]} onNavigate={jest.fn()} />)
  expect(screen.getByText("artifacts:s1:true")).toBeVisible()
  expect(screen.getByRole("status")).toHaveTextContent("loading")
  expect(screen.queryByText("unavailable")).not.toBeInTheDocument()
  expect(await screen.findByText("unavailable")).toBeVisible()
  expect(load).not.toHaveBeenCalled()
})
it("loads concrete changes without mutating the run state and opens their workspace", async () => {
  activate()
  load.mockResolvedValue([row])
  const navigate = jest.fn()
  render(<SessionResultsSection session={session} messages={[]} onNavigate={navigate} />)
  expect(screen.getByRole("status")).toHaveTextContent("loading")
  expect(screen.queryByText("unavailable")).not.toBeInTheDocument()
  expect(await screen.findByText(row.path)).toBeVisible()
  expect(screen.getByText("modified")).toBeVisible()
  expect(useTaskWorkspaceStore.getState().activeBySession.s1.state).toBe("running")
  fireEvent.click(screen.getByRole("button", { name: "openWorkspace" }))
  expect(navigate).toHaveBeenCalledWith("workspace")
})
it("shows cached changes and allows retry after a fetch failure", async () => {
  activate()
  useTaskWorkspaceStore.setState({ resourcesByTask: { "task-s1": [row] } })
  load.mockRejectedValueOnce(new Error("offline"))
  render(<SessionResultsSection session={session} messages={[]} onNavigate={jest.fn()} />)
  expect(screen.getByText(row.path)).toBeVisible()
  expect(await screen.findByRole("alert")).toHaveTextContent("failed")
  fireEvent.click(screen.getByRole("button", { name: "retry" }))
  expect(await screen.findByText("emptyFiles")).toBeVisible()
})
it("discards a previous session response after scope switching", async () => {
  activate()
  activate("s2")
  let resolve!: (rows: ResourceChange[]) => void
  load.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const { rerender } = render(
    <SessionResultsSection session={session} messages={[]} onNavigate={jest.fn()} />
  )
  rerender(
    <SessionResultsSection
      session={{ id: "s2" } as ChatSession}
      messages={[]}
      onNavigate={jest.fn()}
    />
  )
  expect(await screen.findByText("emptyFiles")).toBeVisible()
  await act(async () => {
    resolve([row])
  })
  expect(screen.queryByText(row.path)).not.toBeInTheDocument()
})
it("refreshes on a new resource revision", async () => {
  activate()
  render(<SessionResultsSection session={session} messages={[]} onNavigate={jest.fn()} />)
  await screen.findByText("emptyFiles")
  load.mockResolvedValue([row])
  act(() =>
    useTaskWorkspaceStore.setState({ provisionalByRun: { "run-s1": { revision: 2 } as never } })
  )
  await waitFor(() => expect(screen.getByText(row.path)).toBeVisible())
})
it("includes only safe typed assistant output files, deduplicating links", async () => {
  const messages = [
    {
      id: "u",
      role: "user",
      parts: [{ type: "file", url: "https://example.com/input", filename: "Input" }],
    },
    {
      id: "a",
      role: "assistant",
      parts: [
        {
          type: "source-url",
          sourceId: "c",
          url: "https://example.com/citation",
          title: "Citation",
        },
        { type: "file", url: "https://example.com/output", filename: "Report.pdf" },
        { type: "file", url: "https://example.com/output", filename: "Report.pdf" },
        { type: "file", url: "javascript:alert(1)", filename: "Unsafe" },
        { type: "file", url: "incomplete", filename: "Incomplete" },
        { type: "file", url: "https://example.com/unnamed" },
      ],
    },
  ] as UIMessage[]
  render(<SessionResultsSection session={session} messages={messages} onNavigate={jest.fn()} />)
  expect(screen.getAllByRole("link")).toHaveLength(2)
  expect(screen.getByRole("link", { name: "Report.pdf" })).toHaveAttribute(
    "href",
    "https://example.com/output"
  )
  expect(screen.queryByText("Input")).not.toBeInTheDocument()
  expect(screen.queryByText("Citation")).not.toBeInTheDocument()
  await screen.findByText("unavailable")
})

it("restores all session workspaces after reload without activating a run", async () => {
  jest.mocked(listTaskWorkspaces).mockResolvedValue([
    { taskId: "older", sessionId: "s1" },
    { taskId: "newer", sessionId: "s1" },
    { taskId: "foreign", sessionId: "other" },
  ] as never)
  load.mockImplementation(async (id) => [{ ...row, path: `${id}.ts` }])
  render(<SessionResultsSection session={session} messages={[]} onNavigate={jest.fn()} />)
  expect(await screen.findByText("older.ts")).toBeVisible()
  expect(screen.getByText("newer.ts")).toBeVisible()
  expect(screen.queryByText("unavailable")).not.toBeInTheDocument()
  expect(load).not.toHaveBeenCalledWith("foreign")
  expect(useTaskWorkspaceStore.getState().activeBySession.s1).toBeUndefined()
})

it("reuses file previews for persisted data and blob outputs", async () => {
  const messages = [
    {
      id: "a",
      role: "assistant",
      parts: [
        {
          type: "file",
          url: "data:text/plain;base64,YQ==",
          filename: "notes.txt",
          mediaType: "text/plain",
        },
        {
          type: "file",
          url: "blob:https://example.com/123",
          filename: "image.png",
          mediaType: "image/png",
        },
      ],
    },
  ] as UIMessage[]
  render(<SessionResultsSection session={session} messages={messages} onNavigate={jest.fn()} />)
  expect(screen.getByRole("link", { name: "notes.txt" })).toHaveAttribute(
    "href",
    "data:text/plain;base64,YQ=="
  )
  expect(screen.getByRole("link", { name: "image.png" })).toHaveAttribute(
    "href",
    "blob:https://example.com/123"
  )
  await screen.findByText("unavailable")
})

it("lists assistant shared document and PR links without claiming creation or status", async () => {
  const messages = [
    { id: "u", role: "user", parts: [{ type: "text", text: "https://example.com/input" }] },
    {
      id: "a",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "[Document](https://example.com/doc). [PR](https://github.com/acme/app/pull/4) https://github.com/acme/app/pull/4. https://example.com/output https://[broken",
        },
        { type: "file", url: "https://example.com/output", filename: "Output" },
        { type: "source-url", sourceId: "c", url: "https://example.com/citation" },
      ],
    },
  ] as UIMessage[]
  render(<SessionResultsSection session={session} messages={messages} onNavigate={jest.fn()} />)
  expect(screen.getByText("sharedLinksDescription")).toBeVisible()
  expect(screen.getByRole("link", { name: "https://example.com/doc" })).toBeVisible()
  expect(screen.getByRole("link", { name: "https://github.com/acme/app/pull/4" })).toBeVisible()
  expect(screen.getAllByRole("link")).toHaveLength(3)
  await screen.findByText("unavailable")
})

it("subscribes before opening workspace and refreshes on a settle without a revision", async () => {
  activate()
  const stop = jest.fn()
  jest.mocked(installTaskWorkspaceEventListener).mockResolvedValue(stop)
  const view = render(
    <SessionResultsSection session={session} messages={[]} onNavigate={jest.fn()} />
  )
  await screen.findByText("emptyFiles")
  expect(installTaskWorkspaceEventListener).toHaveBeenCalledTimes(1)
  load.mockResolvedValue([row])
  act(() => useTaskWorkspaceStore.getState().reconcileRun("run-s1", [row]))
  expect(await screen.findByText(row.path)).toBeVisible()
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  view.unmount()
  expect(stop).toHaveBeenCalledTimes(1)
})
it("cleans up a listener that finishes installing after unmount", async () => {
  let finish!: (stop: () => void) => void
  jest.mocked(installTaskWorkspaceEventListener).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const view = render(
    <SessionResultsSection session={session} messages={[]} onNavigate={jest.fn()} />
  )
  await screen.findByText("unavailable")
  view.unmount()
  const stop = jest.fn()
  await act(async () => finish(stop))
  expect(stop).toHaveBeenCalledTimes(1)
})
it("surfaces listener failure and retries its installation", async () => {
  jest.mocked(installTaskWorkspaceEventListener).mockRejectedValueOnce(new Error("offline"))
  render(<SessionResultsSection session={session} messages={[]} onNavigate={jest.fn()} />)
  expect(await screen.findByRole("alert")).toHaveTextContent("failed")
  fireEvent.click(screen.getByRole("button", { name: "retry" }))
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
  expect(installTaskWorkspaceEventListener).toHaveBeenCalledTimes(2)
})

it("keeps unsupported browser tracking unavailable without futile requests", () => {
  jest.mocked(hasWorkspaceFsBackend).mockReturnValue(false)
  render(<SessionResultsSection session={session} messages={[]} onNavigate={jest.fn()} />)
  expect(screen.getByText("unavailable")).toBeVisible()
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  expect(listTaskWorkspaces).not.toHaveBeenCalled()
  expect(installTaskWorkspaceEventListener).not.toHaveBeenCalled()
})

it("hides empty compact results and shows only this session's concrete output counts", async () => {
  jest.mocked(hasWorkspaceFsBackend).mockReturnValue(false)
  useArtifactStore.setState({
    artifacts: { foreign: { id: "foreign", sessionId: "other" } as never },
  })
  const navigate = jest.fn()
  const view = render(
    <SessionResultsSection session={session} messages={[]} onNavigate={navigate} compact />
  )
  expect(view.container).toBeEmptyDOMElement()
  act(() =>
    useArtifactStore.setState({ artifacts: { own: { id: "own", sessionId: "s1" } as never } })
  )
  // The count is the tile's own label now, not a sentence: "1 artifacts" read
  // as prose in a `ghost` button that looked like nothing clickable.
  const tile = screen.getByRole("button", { name: "1 artifacts" })
  expect(tile.className).toContain("border-info/30")
  fireEvent.click(tile)
  expect(navigate).toHaveBeenCalledWith("artifacts")
  expect(screen.queryByText("unavailable")).not.toBeInTheDocument()
  expect(screen.queryByText("artifacts:s1:true")).not.toBeInTheDocument()
})
it("keeps compact file and link previews bounded and routes the full list", async () => {
  activate()
  load.mockResolvedValue([row])
  const navigate = jest.fn()
  const messages = [
    {
      id: "a",
      role: "assistant",
      parts: [
        ...Array.from({ length: 4 }, (_, i) => ({
          type: "file",
          url: `https://example.com/file${i}`,
          filename: `file${i}`,
        })),
        {
          type: "text",
          text: "https://example.com/doc1 https://example.com/doc2 https://example.com/doc3 https://example.com/doc4",
        },
      ],
    },
  ] as UIMessage[]
  render(
    <SessionResultsSection session={session} messages={messages} onNavigate={navigate} compact />
  )
  const files = await screen.findByRole("button", { name: "1 files" })
  expect(files.className).toContain("border-success/30")
  fireEvent.click(files)
  expect(navigate).toHaveBeenCalledWith("workspace")
  expect(screen.getAllByRole("link")).toHaveLength(6)
  expect(screen.queryByText("file3")).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "title" }))
  expect(navigate).toHaveBeenCalledWith("metadata")
})
