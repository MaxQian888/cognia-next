/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("@/lib/browser/local-client", () => ({
  localBrowser: {
    onEvent: jest.fn(),
    createSession: jest.fn(),
    closeSession: jest.fn(),
    subscribeFrames: jest.fn(),
    rpc: jest.fn(),
  },
}))
jest.mock("@/lib/browser/agent-engine", () => ({
  BROWSER_AGENT_LOCAL_SESSION_EVENT: "cognia:browser:agent-local-session",
  configureLocalBrowserEngine: jest.fn(),
}))
jest.mock("@/lib/browser/local-chromium-engine", () => ({
  LocalChromiumEngine: jest.fn().mockImplementation((sessionId: string, backend: string) => ({
    sessionId,
    backend,
    navigate: jest.fn().mockResolvedValue(undefined),
    listPages: jest
      .fn()
      .mockResolvedValue([
        { id: "p1", url: "https://example.com/", title: "Example", active: true },
      ]),
  })),
}))

import { configureLocalBrowserEngine } from "@/lib/browser/agent-engine"
import { localBrowser, type LocalBrowserEvent } from "@/lib/browser/local-client"

import { useLocalBrowserSession } from "./use-local-browser-session"

const client = localBrowser as unknown as Record<string, jest.Mock>
const configure = configureLocalBrowserEngine as jest.Mock

let emitEvent: (event: LocalBrowserEvent) => void = () => undefined
let emitFrame: (bytes: Uint8Array) => void = () => undefined
const unlistenEvents = jest.fn()
const unsubscribeFrames = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  client.onEvent.mockImplementation(async (cb) => {
    emitEvent = cb
    return unlistenEvents
  })
  client.createSession.mockImplementation(async ({ id }) => ({ id }))
  client.closeSession.mockResolvedValue(undefined)
  client.rpc.mockResolvedValue(undefined)
  client.subscribeFrames.mockImplementation(async (_id, cb) => {
    emitFrame = cb
    return unsubscribeFrames
  })
})

function renderSession(overrides: Partial<Parameters<typeof useLocalBrowserSession>[0]> = {}) {
  const onFrame = jest.fn()
  const hook = renderHook(() =>
    useLocalBrowserSession({
      backend: "local-chromium",
      initialUrl: "https://example.com",
      onFrame,
      createSessionId: () => "pane-1",
      ...overrides,
    })
  )
  return { ...hook, onFrame }
}

it("creates a headless session, binds agent routing, streams frames and loads the first page", async () => {
  const { result, onFrame } = renderSession()
  await waitFor(() => expect(result.current.state).toBe("ready"))
  expect(client.createSession).toHaveBeenCalledWith({
    id: "pane-1",
    kind: "local",
    headless: true,
    allowFileUrls: true,
  })
  expect(configure).toHaveBeenCalledWith({ sessionId: "pane-1", backend: "local-chromium" })
  expect(result.current.engine?.navigate).toHaveBeenCalledWith("https://example.com")
  expect(result.current.pages).toHaveLength(1)
  expect(result.current.activePageId).toBe("p1")

  emitFrame(new Uint8Array([1]))
  expect(onFrame).toHaveBeenCalledWith(new Uint8Array([1]))
})

it("follows tab changes, dialogs and session end for its own session only", async () => {
  const { result } = renderSession()
  await waitFor(() => expect(result.current.state).toBe("ready"))

  act(() =>
    emitEvent({
      type: "pages.changed",
      sessionId: "other",
      pages: [],
    })
  )
  expect(result.current.pages).toHaveLength(1)

  act(() =>
    emitEvent({
      type: "pages.changed",
      sessionId: "pane-1",
      pages: [
        { id: "p1", url: "a", title: "A", active: false },
        { id: "p2", url: "b", title: "B", active: true },
      ],
    })
  )
  expect(result.current.pages).toHaveLength(2)
  expect(result.current.activePageId).toBe("p2")

  act(() =>
    emitEvent({
      type: "dialog.opened",
      sessionId: "pane-1",
      dialog: { type: "prompt", message: "Name?", defaultValue: "x" },
    })
  )
  expect(result.current.dialog).toEqual({ type: "prompt", message: "Name?", defaultValue: "x" })
  act(() => result.current.dismissDialog())
  expect(result.current.dialog).toBeNull()

  act(() => emitEvent({ type: "dialog.opened", sessionId: "pane-1" }))
  expect(result.current.dialog).toEqual({ type: "alert", message: "" })

  act(() => emitEvent({ type: "session.closed", sessionId: "pane-1" }))
  expect(result.current.state).toBe("closed")
  expect(configure).toHaveBeenLastCalledWith(null)
})

it("closes its session and unbinds routing on unmount", async () => {
  const { result, unmount } = renderSession()
  await waitFor(() => expect(result.current.state).toBe("ready"))
  unmount()
  expect(unsubscribeFrames).toHaveBeenCalled()
  expect(unlistenEvents).toHaveBeenCalled()
  expect(configure).toHaveBeenLastCalledWith(null)
  await waitFor(() => expect(client.closeSession).toHaveBeenCalledWith("pane-1"))
  expect(client.rpc).not.toHaveBeenCalled()
})

it("attaches the chosen browser for user-chrome and closes only its own tabs", async () => {
  const { result, unmount } = renderSession({
    backend: "user-chrome",
    userChromeBrowser: "edge",
    initialUrl: undefined,
  })
  await waitFor(() => expect(result.current.state).toBe("ready"))
  expect(client.createSession).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "user-chrome", browser: "edge" })
  )
  expect(result.current.engine?.navigate).not.toHaveBeenCalled()
  unmount()
  await waitFor(() => expect(client.closeSession).toHaveBeenCalledWith("pane-1"))
  expect(client.rpc).toHaveBeenCalledWith("browser.tabs.finalize", { sessionId: "pane-1" })
})

it("reports a failed start and can restart", async () => {
  client.createSession.mockRejectedValueOnce(new Error("browser_local_not_installed"))
  const { result } = renderSession()
  await waitFor(() => expect(result.current.state).toBe("failed"))
  expect(result.current.error).toBe("browser_local_not_installed")
  act(() => result.current.restart())
  expect(result.current.state).toBe("starting")
  await waitFor(() => expect(result.current.state).toBe("ready"))
})

it("adopts the agent's session for the same backend and drops its own", async () => {
  const { result } = renderSession()
  await waitFor(() => expect(result.current.sessionId).toBe("pane-1"))

  act(() => {
    window.dispatchEvent(
      new CustomEvent("cognia:browser:agent-local-session", {
        detail: { sessionId: "agent-9", backend: "user-chrome" },
      })
    )
  })
  expect(result.current.sessionId).toBe("pane-1")

  act(() => {
    window.dispatchEvent(
      new CustomEvent("cognia:browser:agent-local-session", {
        detail: { sessionId: "agent-9", backend: "local-chromium" },
      })
    )
  })
  await waitFor(() => expect(result.current.sessionId).toBe("agent-9"))
  await waitFor(() => expect(client.closeSession).toHaveBeenCalledWith("pane-1"))
  expect(client.createSession).toHaveBeenCalledTimes(1)
  expect(configure).toHaveBeenLastCalledWith({ sessionId: "agent-9", backend: "local-chromium" })
  // The adopted session is already where the agent left it: no navigation.
  expect(result.current.engine?.navigate).not.toHaveBeenCalled()
})

it("detaches from an adopted agent session on unmount instead of closing it", async () => {
  const { result, unmount } = renderSession({ backend: "user-chrome", initialUrl: undefined })
  await waitFor(() => expect(result.current.sessionId).toBe("pane-1"))
  act(() => {
    window.dispatchEvent(
      new CustomEvent("cognia:browser:agent-local-session", {
        detail: { sessionId: "agent-9", backend: "user-chrome" },
      })
    )
  })
  await waitFor(() => expect(result.current.state).toBe("ready"))
  expect(result.current.sessionId).toBe("agent-9")
  unmount()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(client.closeSession).not.toHaveBeenCalledWith("agent-9")
  expect(client.rpc).not.toHaveBeenCalledWith("browser.tabs.finalize", { sessionId: "agent-9" })
  expect(unsubscribeFrames).toHaveBeenCalled()
})

it("refreshes pages on demand", async () => {
  const { result } = renderSession()
  await waitFor(() => expect(result.current.state).toBe("ready"))
  await act(async () => result.current.refreshPages())
  expect(result.current.engine?.listPages).toHaveBeenCalledTimes(2)
})
