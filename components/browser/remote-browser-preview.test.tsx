/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))

const transportCall = jest.fn()
jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: (...args: unknown[]) => transportCall(...args) },
}))
jest.mock("@/lib/tauri/transport-companion", () => ({
  loadCompanionConfig: () => ({ baseUrl: "https://cloud.example.com" }),
}))
jest.mock("@/lib/platform/web-companion", () => ({
  buildTimeServerUrl: () => null,
}))
jest.mock("@/lib/db/browser-profiles", () => ({
  listBrowserDomainGrants: () => Promise.resolve([{ domain: "example.com" }]),
  listBrowserProfiles: () => Promise.resolve([]),
  touchBrowserProfile: jest.fn().mockResolvedValue(undefined),
}))
const sendScreenshotBytes = jest.fn().mockResolvedValue(true)
const sendComment = jest.fn().mockResolvedValue(true)
const sendText = jest.fn().mockResolvedValue(true)
jest.mock("@/hooks/browser/use-selection-to-chat", () => ({
  useSelectionToChat: () => ({ sendScreenshotBytes, sendComment, sendText }),
}))
jest.mock("@/components/browser/browser-recorder-panel", () => ({
  BrowserRecorderPanel: () => <div data-testid="remote-browser-recorder" />,
}))
const openExternal = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/opener", () => ({
  openExternal: (...args: unknown[]) => openExternal(...args),
}))

const navigate = jest.fn().mockResolvedValue(undefined)
const back = jest.fn().mockResolvedValue(undefined)
const forward = jest.fn().mockResolvedValue(undefined)
const reload = jest.fn().mockResolvedValue(undefined)
const activatePage = jest.fn().mockResolvedValue(undefined)
const closePage = jest.fn().mockResolvedValue(undefined)
const setZoom = jest.fn().mockResolvedValue({ ok: true, zoom: 1.1 })
const find = jest.fn().mockResolvedValue({ matches: 2, index: 0 })
const findClear = jest.fn().mockResolvedValue(undefined)
const screenshot = jest.fn().mockResolvedValue({
  bytes: "REMOTE_PNG",
  width: 1280,
  height: 720,
})
const snapshot = jest.fn().mockResolvedValue({
  generation: 1,
  url: "https://example.com/current",
  title: "Current",
  nodes: [
    {
      ref: "e1",
      role: "button",
      name: "Buy",
      tag: "button",
      rect: { x: 0, y: 0, width: 1, height: 1 },
      value: null,
      state: { disabled: false, checked: null, expanded: null },
    },
  ],
})
const evaluate = jest.fn().mockResolvedValue({
  ok: true,
  value: JSON.stringify({
    ok: true,
    selection: {
      paneId: "remote",
      selector: "#buy",
      domPath: "body > button",
      tagName: "BUTTON",
      id: "buy",
      classes: null,
      rect: { x: 0, y: 0, width: 1, height: 1 },
      outerHTML: '<button id="buy">Buy</button>',
      text: "Buy",
      pageUrl: "https://example.com/current",
      pageTitle: "Current",
    },
  }),
})
const listPages = jest
  .fn()
  .mockResolvedValue([{ id: "page-1", url: "https://example.com", title: "Example", active: true }])
jest.mock("@/lib/browser/remote-chromium-engine", () => ({
  RemoteChromiumEngine: jest.fn().mockImplementation(() => ({
    navigate,
    back,
    forward,
    reload,
    activatePage,
    closePage,
    listPages,
    setZoom,
    find,
    findClear,
    screenshot,
    snapshot,
    evaluate,
  })),
}))
// History dropdown renders inline via the shared manual mock.
jest.mock("@/components/ui/dropdown-menu")

import type { RemoteBrowserStreamOptions } from "@/lib/browser/remote-stream"
import { RemoteBrowserPreview } from "./remote-browser-preview"

let streamOptions: RemoteBrowserStreamOptions | null = null
const takeover = jest.fn()
const sendInput = jest.fn(() => true)
const connect = jest.fn().mockResolvedValue(undefined)
const close = jest.fn()
const createStream = (options: RemoteBrowserStreamOptions) => {
  streamOptions = options
  return { connect, close, takeover, sendInput }
}

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({ drawImage: jest.fn(), clearRect: jest.fn() }),
  })
})

beforeEach(() => {
  jest.clearAllMocks()
  streamOptions = null
  transportCall.mockImplementation((name: string) => {
    if (name === "browser_capability") {
      return Promise.resolve({ capabilities: ["browser"] })
    }
    if (name === "browser_session_ensure") {
      return Promise.resolve({
        id: "browser-1",
        state: "ready",
        pages: [{ id: "page-1", url: "about:blank", title: "", active: true }],
        activePageId: "page-1",
      })
    }
    if (name === "browser_stream_ticket_issue") {
      return Promise.resolve({ ticket: "once", expiresAt: Date.now() + 60_000 })
    }
    return Promise.resolve(undefined)
  })
})

it("ensures a user-gated session and connects through a one-time ticket", async () => {
  render(
    <RemoteBrowserPreview
      chatSessionId="chat-1"
      parentChatSessionId="parent-1"
      workspaceId="workspace-1"
      initialUrl="https://example.com"
      createStream={createStream}
    />
  )

  await waitFor(() => expect(connect).toHaveBeenCalled())
  expect(transportCall).toHaveBeenCalledWith("browser_session_ensure", {
    chatSessionId: "chat-1",
    parentChatSessionId: "parent-1",
    workspaceId: "workspace-1",
    backendPreference: "remote-chromium",
    userEnabled: true,
    domainGrants: ["example.com"],
  })
  expect(navigate).toHaveBeenCalledWith("https://example.com")
})

it("takes human control before forwarding pointer input", async () => {
  render(
    <RemoteBrowserPreview
      chatSessionId="chat-1"
      workspaceId="workspace-1"
      createStream={createStream}
    />
  )
  await waitFor(() => expect(connect).toHaveBeenCalled())
  fireEvent.click(screen.getByRole("button", { name: "browser.remote.takeover" }))
  expect(takeover).toHaveBeenCalled()

  act(() => {
    streamOptions?.onLease?.({ epoch: 3, controller: { kind: "human", id: "device-1" } })
  })
  const canvas = screen.getByRole("application", { name: "browser.remote.canvas" })
  Object.defineProperty(canvas, "getBoundingClientRect", {
    value: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  })
  fireEvent(
    canvas,
    new MouseEvent("pointerdown", { bubbles: true, clientX: 400, clientY: 300, button: 0 })
  )
  expect(sendInput).toHaveBeenCalledWith({
    kind: "mouse",
    payload: expect.objectContaining({ type: "mousePressed", button: "left" }),
  })
  expect(screen.getByTestId("remote-browser-click-pointer")).toHaveStyle({
    left: "50%",
    top: "50%",
  })

  fireEvent(
    canvas,
    new MouseEvent("pointerdown", { bubbles: true, clientX: -10, clientY: 700, button: 0 })
  )
  expect(screen.getByTestId("remote-browser-click-pointer")).toHaveStyle({
    left: "0%",
    top: "100%",
  })
})

it("automatically binds a team child session to its parent browser", async () => {
  render(
    <RemoteBrowserPreview
      chatSessionId="team-1::char::designer::turn-1"
      workspaceId="workspace-1"
      createStream={createStream}
    />
  )
  await waitFor(() =>
    expect(transportCall).toHaveBeenCalledWith(
      "browser_session_ensure",
      expect.objectContaining({
        chatSessionId: "team-1::char::designer::turn-1",
        parentChatSessionId: "team-1",
      })
    )
  )
})

it("zooms and searches the remote page through the engine", async () => {
  render(
    <RemoteBrowserPreview
      chatSessionId="chat-1"
      workspaceId="workspace-1"
      createStream={createStream}
    />
  )
  await waitFor(() => expect(streamOptions).not.toBeNull())
  // Controls enable once the stream reports connected.
  act(() => streamOptions?.onState?.("connected"))
  fireEvent.click(screen.getByRole("button", { name: "browser.zoom.in" }))
  await waitFor(() => expect(setZoom).toHaveBeenCalledWith(1.1))
  fireEvent.click(screen.getByRole("button", { name: "browser.remote.find" }))
  fireEvent.change(screen.getByPlaceholderText("browser.find.placeholder"), {
    target: { value: "abc" },
  })
  await waitFor(() => expect(find).toHaveBeenCalledWith("abc", { forward: true }))
})

it("reuses the shared navigation controls with the remote engine", async () => {
  render(
    <RemoteBrowserPreview
      chatSessionId="chat-1"
      workspaceId="workspace-1"
      createStream={createStream}
    />
  )
  await waitFor(() => expect(streamOptions).not.toBeNull())
  act(() => streamOptions?.onState?.("connected"))

  fireEvent.click(screen.getByRole("button", { name: "browser.actions.back" }))
  fireEvent.click(screen.getByRole("button", { name: "browser.actions.forward" }))
  fireEvent.click(screen.getByRole("button", { name: "browser.actions.reload" }))

  await waitFor(() => {
    expect(back).toHaveBeenCalledTimes(1)
    expect(forward).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

it("forwards wheel input while the human owns the remote lease", async () => {
  render(
    <RemoteBrowserPreview
      chatSessionId="chat-1"
      workspaceId="workspace-1"
      createStream={createStream}
    />
  )
  await waitFor(() => expect(streamOptions).not.toBeNull())
  act(() => {
    streamOptions?.onLease?.({ epoch: 3, controller: { kind: "human", id: "device-1" } })
  })

  fireEvent.wheel(screen.getByRole("application", { name: "browser.remote.canvas" }), {
    deltaX: 4,
    deltaY: 120,
  })

  expect(sendInput).toHaveBeenCalledWith({
    kind: "mouse",
    payload: { type: "mouseWheel", deltaX: 4, deltaY: 120 },
  })
})

it("keeps the address bar synchronized with in-page remote navigation", async () => {
  render(
    <RemoteBrowserPreview
      chatSessionId="chat-1"
      workspaceId="workspace-1"
      createStream={createStream}
    />
  )
  await waitFor(() => expect(streamOptions).not.toBeNull())

  act(() => {
    streamOptions?.onEvent?.({
      kind: "pages.changed",
      pages: [
        {
          id: "page-1",
          url: "https://example.com/after-click",
          title: "After",
          active: true,
        },
      ],
      activePageId: "page-1",
    })
  })

  expect(screen.getByRole("textbox", { name: "browser.remote.url" })).toHaveValue(
    "https://example.com/after-click"
  )
})

it("captures through the remote engine and reuses the chat screenshot pipeline", async () => {
  render(
    <RemoteBrowserPreview
      chatSessionId="chat-1"
      workspaceId="workspace-1"
      createStream={createStream}
    />
  )
  await waitFor(() => expect(streamOptions).not.toBeNull())
  act(() => {
    streamOptions?.onState?.("connected")
    streamOptions?.onEvent?.({
      kind: "pages.changed",
      pages: [
        {
          id: "page-1",
          url: "https://example.com/current",
          title: "Current",
          active: true,
        },
      ],
      activePageId: "page-1",
    })
  })

  fireEvent.click(screen.getByRole("button", { name: "browser.actions.screenshot" }))

  await waitFor(() =>
    expect(sendScreenshotBytes).toHaveBeenCalledWith("REMOTE_PNG", {
      sessionId: "chat-1",
      pageUrl: "https://example.com/current",
    })
  )
})

it("opens the active remote page through the shared external opener", async () => {
  render(
    <RemoteBrowserPreview
      chatSessionId="chat-1"
      workspaceId="workspace-1"
      createStream={createStream}
    />
  )
  await waitFor(() => expect(streamOptions).not.toBeNull())
  act(() => {
    streamOptions?.onEvent?.({
      kind: "pages.changed",
      pages: [
        {
          id: "page-1",
          url: "https://example.com/current",
          title: "Current",
          active: true,
        },
      ],
      activePageId: "page-1",
    })
  })

  fireEvent.click(screen.getByRole("button", { name: "browser.actions.openExternal" }))

  expect(openExternal).toHaveBeenCalledWith("https://example.com/current")
})

it("selects a remote element by snapshot ref and sends it through the shared comment pipeline", async () => {
  render(
    <RemoteBrowserPreview
      chatSessionId="chat-1"
      workspaceId="workspace-1"
      createStream={createStream}
    />
  )
  await waitFor(() => expect(streamOptions).not.toBeNull())
  act(() => streamOptions?.onState?.("connected"))

  fireEvent.click(screen.getByRole("button", { name: "browser.actions.selectElement" }))
  const canvas = screen.getByRole("application", { name: "browser.remote.canvas" })
  Object.defineProperty(canvas, "getBoundingClientRect", {
    value: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  })
  await act(async () => {
    fireEvent(
      canvas,
      new MouseEvent("pointerdown", { bubbles: true, clientX: 50, clientY: 50, button: 0 })
    )
    await Promise.resolve()
    await Promise.resolve()
  })

  expect(snapshot).toHaveBeenCalledWith({ includeText: true })
  expect(evaluate).toHaveBeenCalledWith('window.__cogniaSelectionForRef("e1")')
  expect(screen.getByRole("textbox", { name: "browser.comment.title" })).toBeInTheDocument()
  expect(sendInput).not.toHaveBeenCalledWith({
    kind: "mouse",
    payload: expect.objectContaining({ type: "mousePressed" }),
  })

  fireEvent.change(screen.getByRole("textbox", { name: "browser.comment.title" }), {
    target: { value: "Make this clearer" },
  })
  fireEvent.click(screen.getByRole("button", { name: "browser.comment.send" }))

  await waitFor(() =>
    expect(sendComment).toHaveBeenCalledWith(
      expect.objectContaining({ selector: "#buy" }),
      "Make this clearer",
      { sessionId: "chat-1" }
    )
  )
})

it("switches and closes pages through the host-neutral engine", async () => {
  listPages.mockResolvedValueOnce([
    { id: "page-1", url: "https://example.com", title: "Example", active: true },
    { id: "page-2", url: "https://example.com/two", title: "Two", active: false },
  ])
  render(
    <RemoteBrowserPreview
      chatSessionId="chat-1"
      workspaceId="workspace-1"
      createStream={createStream}
    />
  )
  await screen.findByRole("button", { name: "Two" })
  fireEvent.click(screen.getByRole("button", { name: "Two" }))
  await waitFor(() => expect(activatePage).toHaveBeenCalledWith("page-2"))
  fireEvent.click(screen.getAllByRole("button", { name: "browser.remote.closePage" })[1])
  await waitFor(() => expect(closePage).toHaveBeenCalled())
})
